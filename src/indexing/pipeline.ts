import joplin from 'api';
import { getDatabase, run } from '../storage/db';
import type { LLMProvider } from '../llm/provider';
import { errorMessage } from '../util/errors';
import { computeContentHash } from './hash';
import { chunkNote } from './chunker';
import { embedChunks } from './embedder';
import { shouldReprocess, purgeNote } from './delta';
import { fetchTagsForNote } from './extractors/tags';
import { writeStructuralGraphForNote, purgeGraphForNote } from './graphWriter';
import {
	insertChunks,
	insertEmbeddings,
	upsertNotesSnapshot,
	upsertIndexState,
	deleteChunksAndEdgesForNote,
	withPerNoteTransaction,
} from './persist';
import { resolveScope, fetchNotesPaginated } from './scopes';
import type { Scope } from './scopes';
import { isVaultLocked } from './vault';

export interface IndexOptions {
	force?: boolean;
	batchSize?: number;
	onProgress?: (processed: number, total: number) => void;
	maxChars?: number;
	overlapChars?: number;
	embeddingBatchSize?: number;
}

export interface IndexResult {
	notesProcessed: number;
	chunksCreated: number;
	skipped: number;
	errors: { noteId: string; message: string }[];
	unresolvedLinks: number;
}

let running: Promise<IndexResult> | null = null;
let pendingScope: { scope: Scope; options: IndexOptions } | null = null;

async function getFolderInfo(folderId: string): Promise<{ title: string | null }> {
	try {
		const folder: any = await (joplin as any).data.get(['folders', folderId], { fields: ['title'] });
		return { title: folder?.title ?? null };
	} catch {
		return { title: null };
	}
}

async function processSingleNote(
	note: { id: string; title: string; body: string; parent_id?: string | null; created_time?: number; updated_time?: number },
	provider: LLMProvider,
	options: IndexOptions,
	stats: { chunksCreated: number; unresolvedLinks: number },
): Promise<{ skipped: boolean; error?: string }> {
	const db = getDatabase();
	const contentHash = computeContentHash(note.title ?? '', note.body ?? '');

	const decision = await shouldReprocess(db, note.id, contentHash, { force: options.force });
	if (!decision.shouldReprocess) {
		return { skipped: true };
	}

	const chunks = chunkNote(note.id, note.title ?? '', note.body ?? '', {
		maxChars: options.maxChars,
		overlapChars: options.overlapChars,
	});

	let vectors: number[][] | null = null;
	let modelName = (provider as any).model ?? 'unknown';
	let dims = 0;

	if (chunks.length > 0) {
		try {
			const emb = await embedChunks(
				provider,
				chunks.map((c) => c.content),
				{ batchSize: options.embeddingBatchSize, modelName },
			);
			vectors = emb.vectors;
			modelName = emb.model;
			dims = emb.dims;
		} catch (error) {
			const message = errorMessage(error);
			// Record failure but still persist chunks/graph? Spec says isolate failure.
			// We mark failed and do not delete previous data? But reprocess should be atomic.
			// For now, persist chunks and mark failed, allow retry.
			try {
				await withPerNoteTransaction(db, async () => {
					await deleteChunksAndEdgesForNote(db, note.id);
					await insertChunks(db, chunks);
					// Don't insert embeddings on failure
					const tags = await fetchTagsForNote(note.id);
					await writeStructuralGraphForNote(db, { id: note.id, title: note.title ?? '', body: note.body ?? '' }, tags);
					await upsertNotesSnapshot(
						db,
						{
							id: note.id,
							title: note.title ?? '',
							parent_id: note.parent_id ?? null,
							contentHash,
							createdAt: note.created_time ? new Date(note.created_time).toISOString() : null,
							updatedAt: note.updated_time ? new Date(note.updated_time).toISOString() : null,
						},
						'failed',
					);
					await upsertIndexState(db, note.id, contentHash, 'failed', message);
				});
			} catch {
				// Log but propagate original embedding error
			}
			return { skipped: false, error: message };
		}
	}

	const tags = await fetchTagsForNote(note.id);

	try {
		await withPerNoteTransaction(db, async () => {
			await deleteChunksAndEdgesForNote(db, note.id);
			if (chunks.length > 0) {
				await insertChunks(db, chunks);
				if (vectors && vectors.length > 0) {
					await insertEmbeddings(db, chunks, vectors, modelName);
				}
			}
			const graphResult = await writeStructuralGraphForNote(
				db,
				{ id: note.id, title: note.title ?? '', body: note.body ?? '' },
				tags,
			);
			stats.unresolvedLinks += graphResult.unresolvedLinks;

			// Need notebook name if parent folder exists - best effort
			let notebookName: string | null = null;
			if (note.parent_id) {
				const folderInfo = await getFolderInfo(note.parent_id);
				notebookName = folderInfo.title;
			}

			await upsertNotesSnapshot(
				db,
				{
					id: note.id,
					title: note.title ?? '',
					parent_id: note.parent_id ?? null,
					notebookId: note.parent_id ?? null,
					notebookName,
					contentHash,
					createdAt: note.created_time ? new Date(note.created_time).toISOString() : null,
					updatedAt: note.updated_time ? new Date(note.updated_time).toISOString() : null,
				},
				'success',
			);
			await upsertIndexState(db, note.id, contentHash, 'success', null);
		});

		stats.chunksCreated += chunks.length;
		return { skipped: false };
	} catch (error) {
		const message = errorMessage(error);
		try {
			await upsertIndexState(db, note.id, contentHash, 'failed', message);
		} catch {}
		return { skipped: false, error: message };
	}
}

async function runIndexInternal(scope: Scope, provider: LLMProvider, options: IndexOptions): Promise<IndexResult> {
	if (await isVaultLocked()) {
		return {
			notesProcessed: 0,
			chunksCreated: 0,
			skipped: 0,
			errors: [{ noteId: '__vault__', message: 'Indexing paused: vault is locked' }],
			unresolvedLinks: 0,
		};
	}

	const result: IndexResult = {
		notesProcessed: 0,
		chunksCreated: 0,
		skipped: 0,
		errors: [],
		unresolvedLinks: 0,
	};

	const stats = { chunksCreated: 0, unresolvedLinks: 0 };

	if (scope.kind === 'note') {
		const note: any = await (joplin as any).data.get(['notes', scope.noteId], {
			fields: ['id', 'title', 'parent_id', 'created_time', 'updated_time', 'body'],
		});
		if (!note || !note.id) {
			result.errors.push({ noteId: scope.noteId, message: 'Note not found' });
			return result;
		}
		const outcome = await processSingleNote(note, provider, options, stats);
		if (outcome.skipped) result.skipped++;
		else {
			result.notesProcessed++;
			if (outcome.error) result.errors.push({ noteId: note.id, message: outcome.error });
		}
		result.chunksCreated = stats.chunksCreated;
		result.unresolvedLinks = stats.unresolvedLinks;
		return result;
	}

	// Folder or all: paginated scan
	let totalToProcess: string[] | null = null;
	if (scope.kind === 'folder') {
		totalToProcess = await resolveScope(scope);
	} else {
		// For 'all', we stream directly
		totalToProcess = null;
	}

	let processed = 0;

	const handleNotes = async (notes: any[]) => {
		for (const note of notes) {
			if (await isVaultLocked()) {
				result.errors.push({ noteId: note.id, message: 'Vault locked during run, stopping' });
				break;
			}
			const outcome = await processSingleNote(note, provider, options, stats);
			if (outcome.skipped) result.skipped++;
			else {
				result.notesProcessed++;
				if (outcome.error) result.errors.push({ noteId: note.id, message: outcome.error });
			}
			processed++;
			if (options.onProgress) options.onProgress(processed, notes.length);
		}
	};

	if (totalToProcess === null) {
		await fetchNotesPaginated(null, {
			batchSize: options.batchSize ?? 50,
			onPage: handleNotes,
		});
	} else {
		await fetchNotesPaginated(totalToProcess, {
			batchSize: 20,
			onPage: handleNotes,
		});

		// Purge orphan notes that were deleted: for 'all' we could detect orphans, but for now only handle explicit deleted via events.
		// For folder scope, do not purge orphans.
	}

	result.chunksCreated = stats.chunksCreated;
	result.unresolvedLinks = stats.unresolvedLinks;
	return result;
}

export async function indexWithMutex(scope: Scope, provider: LLMProvider, options: IndexOptions = {}): Promise<IndexResult> {
	if (running) {
		pendingScope = { scope, options };
		return running;
	}

	const task = runIndexInternal(scope, provider, options);
	running = task;

	try {
		const result = await task;
		return result;
	} finally {
		running = null;
		if (pendingScope) {
			const pending = pendingScope;
			pendingScope = null;
			// Fire-and-forget coalesced run; caller of pending won't await but we log
			void indexWithMutex(pending.scope, provider, pending.options).catch((e) => {
				console.warn('[echo] pending indexing failed', e);
			});
		}
	}
}

export async function indexNote(noteId: string, provider: LLMProvider, options: IndexOptions = {}): Promise<IndexResult> {
	return indexWithMutex({ kind: 'note', noteId }, provider, options);
}

export async function indexFolder(folderId: string, provider: LLMProvider, options: IndexOptions = {}): Promise<IndexResult> {
	return indexWithMutex({ kind: 'folder', folderId }, provider, options);
}

export async function indexAll(provider: LLMProvider, options: IndexOptions = {}): Promise<IndexResult> {
	return indexWithMutex({ kind: 'all' }, provider, options);
}

export async function purgeDeletedNote(noteId: string): Promise<void> {
	const db = getDatabase();
	await withPerNoteTransaction(db, async () => {
		await purgeNote(db, noteId);
		await purgeGraphForNote(db, noteId);
	});
}

export function isIndexingRunning(): boolean {
	return running !== null;
}
