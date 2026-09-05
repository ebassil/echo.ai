import joplin from 'api';
import { getDatabase, run, all } from '../storage/db';
import { errorMessage } from '../util/errors';
import { computeContentHash } from '../indexing/hash';
import { chunkNote } from '../indexing/chunker';
import { resolveScope, fetchNotesPaginated } from '../indexing/scopes';
import type { Scope } from '../indexing/scopes';
import { isVaultLocked } from '../indexing/vault';
import { shouldReprocessSemantic, resolveExpectedExtractionModel } from './delta';
import { extractNote as extractViaPipeline, resolveExtractorOptions } from './extractor';
import { persistSemanticForNote, upsertSemanticIndexState } from './persist';
import { resolveSettings } from '../settings/registry';
import { resolveCascadeOptions, runLazyCascade, runEagerCascade, getEntityIdsForNote } from './cascade';

export interface SemanticIndexOptions {
	force?: boolean;
	batchSize?: number;
	onProgress?: (processed: number, total: number) => void;
	onProgressDetailed?: (processed: number, total: number, currentNoteId: string) => void;
	signal?: AbortSignal;
	cascade?: { mode?: 'lazy' | 'eager'; depth?: number } | false;
	trigger?: string;
	scope?: string;
}

export interface SemanticIndexResult {
	notesProcessed: number;
	entitiesCreated: number;
	relationsCreated: number;
	skipped: number;
	errors: { noteId: string; message: string }[];
}

let running: Promise<SemanticIndexResult> | null = null;
let pendingSemanticScope: { scope: Scope; options: SemanticIndexOptions } | null = null;
let deferredQueue: string[] = [];

async function getNoteContent(noteId: string): Promise<{ id: string; title: string; body: string; parent_id?: string | null; created_time?: number; updated_time?: number } | null> {
	if (await isVaultLocked()) return null;
	try {
		const note: any = await (joplin as any).data.get(['notes', noteId], {
			fields: ['id', 'title', 'parent_id', 'created_time', 'updated_time', 'body'],
		});
		if (!note || !note.id) return null;
		return note;
	} catch {
		return null;
	}
}

async function processSingleSemanticNote(
	note: { id: string; title: string; body: string; parent_id?: string | null; created_time?: number; updated_time?: number },
	provider: any,
	settings: any,
	options: SemanticIndexOptions,
	stats: { entitiesCreated: number; relationsCreated: number },
	embeddingCache: Map<string, number[]>,
): Promise<{ skipped: boolean; error?: string; affectedEntityIds?: string[] }> {
	const db = getDatabase();
	const contentHash = computeContentHash(note.title ?? '', note.body ?? '');
	const expectedModel = resolveExpectedExtractionModel(settings);
	const decision = await shouldReprocessSemantic(db, note.id, contentHash, {
		force: options.force,
		expectedExtractionModel: expectedModel,
	});
	if (!decision.shouldReprocess) {
		return { skipped: true };
	}

	if (await isVaultLocked()) {
		// Queue for later
		if (!deferredQueue.includes(note.id)) deferredQueue.push(note.id);
		return { skipped: false, error: 'Vault locked, deferred' };
	}

	// Capture before entity ids for cascade
	const beforeEntityIds = await getEntityIdsForNote(db, note.id).catch(() => [] as string[]);

	// Build chunks for persistence (need chunk ids)
	const chunks = chunkNote(note.id, note.title ?? '', note.body ?? '', {
		maxChars: settings.chunkSize,
		overlapChars: settings.chunkOverlap,
	});

	let extraction: any;
	try {
		const extractorOptions = resolveExtractorOptions(settings);
		extraction = await extractViaPipeline(provider, note, extractorOptions);
	} catch (e) {
		const message = errorMessage(e);
		try {
			await upsertSemanticIndexState(db, note.id, expectedModel, 'failed', message);
		} catch {}
		return { skipped: false, error: message };
	}

	try {
		const persistResult = await persistSemanticForNote(
			db,
			{ id: note.id, title: note.title ?? '' },
			chunks,
			extraction,
			{
				provider,
				canonicalizationMode: settings.canonicalizationMode ?? 'exact',
				canonicalSimilarity: settings.canonicalSimilarity ?? 0.85,
				extractionModel: expectedModel,
				embeddingCache,
			},
		);
		stats.entitiesCreated += persistResult.entitiesCreated;
		stats.relationsCreated += persistResult.relationsCreated;

		// Upsert notes snapshot if not exists
		const now = new Date().toISOString();
		await run(
			db,
			`INSERT INTO notes (id, title, content_hash, parent_id, created_at, updated_at, indexed_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'success')
			 ON CONFLICT(id) DO UPDATE SET title = excluded.title, content_hash = excluded.content_hash, updated_at = excluded.updated_at, indexed_at = excluded.indexed_at`,
			[
				note.id,
				note.title ?? '',
				contentHash,
				note.parent_id ?? null,
				note.created_time ? new Date(note.created_time).toISOString() : null,
				note.updated_time ? new Date(note.updated_time).toISOString() : null,
				now,
			],
		);

		const afterEntityIds = await getEntityIdsForNote(db, note.id).catch(() => [] as string[]);
		const affected = [...new Set([...beforeEntityIds.filter((id) => !afterEntityIds.includes(id)), ...afterEntityIds.filter((id) => !beforeEntityIds.includes(id))])];
		return { skipped: false, affectedEntityIds: affected };
	} catch (e) {
		const message = errorMessage(e);
		try {
			await upsertSemanticIndexState(db, note.id, expectedModel, 'failed', message);
		} catch {}
		return { skipped: false, error: message };
	}
}

async function runSemanticInternal(scope: Scope, provider: any, settings: any, options: SemanticIndexOptions): Promise<SemanticIndexResult> {
	const db = getDatabase();
	const result: SemanticIndexResult = {
		notesProcessed: 0,
		entitiesCreated: 0,
		relationsCreated: 0,
		skipped: 0,
		errors: [],
	};
	const stats = { entitiesCreated: 0, relationsCreated: 0 };
	const embeddingCache = new Map<string, number[]>();

	// Vault gate at start
	if (await isVaultLocked()) {
		result.errors.push({ noteId: '__vault__', message: 'Semantic indexing paused: vault is locked' });
		return result;
	}

	const cascadeOptions = resolveCascadeOptions(settings, options.cascade === false ? { mode: 'lazy' } : (options.cascade as any));

	// For single note scope, handle cascade
	if (scope.kind === 'note') {
		const note = await getNoteContent(scope.noteId);
		if (!note) {
			result.errors.push({ noteId: scope.noteId, message: 'Note not found or vault locked' });
			return result;
		}
		const outcome = await processSingleSemanticNote(note, provider, settings, options, stats, embeddingCache);
		if (outcome.skipped) result.skipped++;
		else {
			result.notesProcessed++;
			if (outcome.error) result.errors.push({ noteId: note.id, message: outcome.error });
			else {
				// Cascade handling
				if (cascadeOptions.mode === 'lazy') {
					await runLazyCascade(db, note.id);
				} else {
					const affected = outcome.affectedEntityIds ?? [];
					await runEagerCascade(db, note.id, affected, cascadeOptions, async (nid) => {
						const n = await getNoteContent(nid);
						if (!n) return;
						const res = await processSingleSemanticNote(n, provider, settings, { ...options, cascade: false }, stats, embeddingCache);
						if (res.skipped) result.skipped++;
						else {
							result.notesProcessed++;
							if (res.error) result.errors.push({ noteId: nid, message: res.error });
						}
					});
					// Count cascaded in notesProcessed already
				}
			}
		}
		result.entitiesCreated = stats.entitiesCreated;
		result.relationsCreated = stats.relationsCreated;
		await logPipelineRun(db, options.trigger ?? 'manual', scope, 'success', result.notesProcessed, result.errors[0]?.message ?? null, cascadeOptions);
		return result;
	}

	// Folder or all: paginated
	let totalIds: string[] | null = null;
	if (scope.kind === 'folder') {
		totalIds = await resolveScope(scope);
	}

	let processed = 0;
	const handleNotes = async (notes: any[]) => {
		for (const note of notes) {
			if (options.signal?.aborted) {
				result.errors.push({ noteId: note.id, message: 'Cancelled' });
				break;
			}
			if (await isVaultLocked()) {
				result.errors.push({ noteId: note.id, message: 'Vault locked during run, stopping' });
				// Queue remaining
				for (const n of notes.slice(processed % notes.length)) if (!deferredQueue.includes(n.id)) deferredQueue.push(n.id);
				break;
			}
			const outcome = await processSingleSemanticNote(note, provider, settings, options, stats, embeddingCache);
			if (outcome.skipped) result.skipped++;
			else {
				result.notesProcessed++;
				if (outcome.error) result.errors.push({ noteId: note.id, message: outcome.error });
			}
			processed++;
			if (options.onProgress) options.onProgress(processed, notes.length);
			if (options.onProgressDetailed) options.onProgressDetailed(processed, notes.length, note.id);
			if (options.signal?.aborted) {
				result.errors.push({ noteId: '__cancel__', message: 'Cancelled after note' });
				break;
			}
		}
	};

	if (totalIds === null) {
		await fetchNotesPaginated(null, {
			batchSize: options.batchSize ?? 50,
			onPage: handleNotes,
		});
	} else {
		await fetchNotesPaginated(totalIds, {
			batchSize: 20,
			onPage: handleNotes,
		});
	}

	result.entitiesCreated = stats.entitiesCreated;
	result.relationsCreated = stats.relationsCreated;
	await logPipelineRun(db, options.trigger ?? 'manual', scope, result.errors.length > 0 ? 'failed' : 'success', result.notesProcessed, result.errors[0]?.message ?? null, cascadeOptions);
	return result;
}

async function logPipelineRun(
	db: any,
	trigger: string,
	scope: Scope,
	status: string,
	notesProcessed: number,
	error: string | null,
	cascadeOptions: any,
): Promise<void> {
	const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	const now = new Date().toISOString();
	const scopeJson = JSON.stringify({ ...scope, cascade: cascadeOptions });
	try {
		await run(
			db,
			`INSERT INTO pipeline_runs (id, pipeline, trigger, scope, status, started_at, finished_at, notes_processed, chunks_created, error) VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, 0, ?)`,
			[id, trigger, scopeJson, status, now, now, notesProcessed, error ? error.slice(0, 1000) : null],
		);
	} catch {}
}

export async function indexWithMutexSemantic(
	scope: Scope,
	provider: any,
	settings: any,
	options: SemanticIndexOptions = {},
): Promise<SemanticIndexResult> {
	if (running) {
		pendingSemanticScope = { scope, options };
		return running;
	}
	const task = runSemanticInternal(scope, provider, settings, options);
	running = task;
	try {
		const result = await task;
		return result;
	} finally {
		running = null;
		if (pendingSemanticScope) {
			const pending = pendingSemanticScope;
			pendingSemanticScope = null;
			void indexWithMutexSemantic(pending.scope, provider, settings, pending.options).catch((e) => console.warn('[echo] pending semantic indexing failed', e));
		}
	}
}

export async function extractNote(noteId: string, options: SemanticIndexOptions = {}): Promise<SemanticIndexResult> {
	const settingsRes = await resolveSettings();
	const provider = (await import('../llm/factory')).createProvider(settingsRes.settings);
	return indexWithMutexSemantic({ kind: 'note', noteId }, provider, settingsRes.settings, options);
}

export async function extractFolder(folderId: string, options: SemanticIndexOptions = {}): Promise<SemanticIndexResult> {
	const settingsRes = await resolveSettings();
	const provider = (await import('../llm/factory')).createProvider(settingsRes.settings);
	return indexWithMutexSemantic({ kind: 'folder', folderId }, provider, settingsRes.settings, options);
}

export async function extractAll(options: SemanticIndexOptions = {}): Promise<SemanticIndexResult> {
	const settingsRes = await resolveSettings();
	const provider = (await import('../llm/factory')).createProvider(settingsRes.settings);
	return indexWithMutexSemantic({ kind: 'all' }, provider, settingsRes.settings, options);
}

export async function getSemanticStatus(noteId: string): Promise<{ status: string; error: string | null } | null> {
	const db = getDatabase();
	const rows = await all<{ semantic_status: string; error: string | null }>(db, `SELECT semantic_status, error FROM index_state WHERE note_id = ?`, [noteId]);
	if (rows.length === 0) return null;
	return { status: rows[0].semantic_status, error: rows[0].error };
}

export async function flushDeferredQueue(): Promise<void> {
	if (deferredQueue.length === 0) return;
	if (await isVaultLocked()) return;
	const settingsRes = await resolveSettings();
	const provider = (await import('../llm/factory')).createProvider(settingsRes.settings);
	const queue = [...deferredQueue];
	deferredQueue = [];
	for (const noteId of queue) {
		try {
			await extractNote(noteId, { trigger: 'startup' });
		} catch (e) {
			console.warn('[echo] deferred extract failed', e);
		}
	}
}

export function isSemanticRunning(): boolean {
	return running !== null;
}

export async function purgeSemanticForDeletedNote(noteId: string): Promise<void> {
	const db = getDatabase();
	const { deleteSemanticForNote } = await import('./persist');
	await deleteSemanticForNote(db, noteId);
	await run(db, `DELETE FROM index_state WHERE note_id = ?`, [noteId]);
	await run(db, `DELETE FROM notes WHERE id = ?`, [noteId]);
}

// ---- Orchestration Pipeline adapter ----
import type { Pipeline, PipelineResult } from '../orchestration/types';

async function runSemanticFromNoteIds(
	noteIds: string[],
	provider: any,
	settings: any,
	options: SemanticIndexOptions & { signal?: AbortSignal; onProgressDetailed?: (p: number, t: number, id: string) => void },
): Promise<PipelineResult> {
	const db = getDatabase();
	if (await isVaultLocked()) {
		return {
			notesProcessed: 0,
			chunksCreated: 0,
			entitiesCreated: 0,
			relationsCreated: 0,
			skipped: 0,
			errors: [{ noteId: '__vault__', message: 'Semantic indexing paused: vault is locked' }],
		};
	}
	const stats = { entitiesCreated: 0, relationsCreated: 0 };
	const embeddingCache = new Map<string, number[]>();
	const result: PipelineResult = {
		notesProcessed: 0,
		chunksCreated: 0,
		entitiesCreated: 0,
		relationsCreated: 0,
		skipped: 0,
		errors: [],
	};
	let processed = 0;
	for (const noteId of noteIds) {
		if (options.signal?.aborted) {
			result.errors.push({ noteId, message: 'Cancelled' });
			break;
		}
		if (await isVaultLocked()) {
			result.errors.push({ noteId, message: 'Vault locked during run' });
			break;
		}
		const note = await getNoteContent(noteId);
		if (!note) {
			result.errors.push({ noteId, message: 'Note not found or vault locked' });
			processed++;
			if (options.onProgress) options.onProgress(processed, noteIds.length);
			if (options.onProgressDetailed) options.onProgressDetailed(processed, noteIds.length, noteId);
			continue;
		}
		const outcome = await processSingleSemanticNote(note, provider, settings, {
			force: options.force,
			cascade: options.cascade,
			onProgressDetailed: options.onProgressDetailed,
			signal: options.signal,
		} as any, stats, embeddingCache);
		if (outcome.skipped) result.skipped++;
		else {
			result.notesProcessed++;
			if (outcome.error) result.errors.push({ noteId, message: outcome.error });
			else {
				const cascadeOptions = resolveCascadeOptions(settings, options.cascade === false ? { mode: 'lazy' } : (options.cascade as any));
				if (cascadeOptions.mode === 'lazy') {
					await runLazyCascade(db, note.id);
				} else {
					const affected = outcome.affectedEntityIds ?? [];
					await runEagerCascade(db, note.id, affected, cascadeOptions, async (nid) => {
						const n = await getNoteContent(nid);
						if (!n) return;
						const res = await processSingleSemanticNote(n, provider, settings, { force: options.force, cascade: false, signal: options.signal } as any, stats, embeddingCache);
						if (res.skipped) result.skipped++;
						else {
							result.notesProcessed++;
							if (res.error) result.errors.push({ noteId: nid, message: res.error });
						}
					});
				}
			}
		}
		processed++;
		if (options.onProgress) options.onProgress(processed, noteIds.length);
		if (options.onProgressDetailed) options.onProgressDetailed(processed, noteIds.length, noteId);
	}
	result.entitiesCreated = stats.entitiesCreated;
	result.relationsCreated = stats.relationsCreated;
	return result;
}

export function createSemanticPipeline(provider: any, settings: any): Pipeline {
	return {
		async run(noteIds: string[], opts: { signal?: AbortSignal; onProgress?: (p: number, t: number, id: string) => void; force?: boolean; cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false }): Promise<PipelineResult> {
			return runSemanticFromNoteIds(noteIds, provider, settings, {
				force: opts.force,
				cascade: opts.cascade,
				signal: opts.signal,
				onProgressDetailed: opts.onProgress,
			});
		},
	};
}
