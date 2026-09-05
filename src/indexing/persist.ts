import { run } from '../storage/db';
import type { Chunk } from './chunker';
import { serializeVector } from './embedder';

function tileTransaction(db: any, sql: string): Promise<void> {
	return run(db, sql);
}

export async function withPerNoteTransaction(
	db: any,
	fn: () => Promise<void>,
	onError?: (error: unknown) => Promise<void>,
): Promise<void> {
	await tileTransaction(db, 'BEGIN IMMEDIATE');
	try {
		await fn();
		await tileTransaction(db, 'COMMIT');
	} catch (error) {
		try {
			await tileTransaction(db, 'ROLLBACK');
		} catch {
			// ignore rollback error
		}
		if (onError) await onError(error);
		throw error;
	}
}

export async function insertChunks(db: any, chunks: Chunk[]): Promise<void> {
	const now = new Date().toISOString();
	for (const chunk of chunks) {
		await run(
			db,
			`INSERT OR REPLACE INTO chunks (id, note_id, chunk_index, content, token_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[chunk.id, chunk.noteId, chunk.chunkIndex, chunk.content, chunk.tokenCount, now],
		);
	}
}

export async function insertEmbeddings(
	db: any,
	chunks: Chunk[],
	vectors: number[][],
	model: string,
): Promise<void> {
	if (chunks.length !== vectors.length) {
		throw new Error(`Mismatched chunks (${chunks.length}) and vectors (${vectors.length})`);
	}
	const now = new Date().toISOString();
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const vector = vectors[i];
		const blob = serializeVector(vector);
		await run(
			db,
			`INSERT OR REPLACE INTO embeddings (chunk_id, model, dims, vector, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[chunk.id, model, vector.length, blob, now],
		);
	}
}

export async function upsertNotesSnapshot(
	db: any,
	note: {
		id: string;
		title: string;
		parent_id?: string | null;
		notebookId?: string | null;
		notebookName?: string | null;
		contentHash: string;
		createdAt?: string | null;
		updatedAt?: string | null;
	},
	status: string,
): Promise<void> {
	const now = new Date().toISOString();
	await run(
		db,
		`INSERT INTO notes (id, title, notebook_id, notebook_name, content_hash, parent_id, created_at, updated_at, indexed_at, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title,
		   notebook_id = excluded.notebook_id,
		   notebook_name = excluded.notebook_name,
		   content_hash = excluded.content_hash,
		   parent_id = excluded.parent_id,
		   created_at = excluded.created_at,
		   updated_at = excluded.updated_at,
		   indexed_at = excluded.indexed_at,
		   status = excluded.status`,
		[
			note.id,
			note.title,
			note.notebookId ?? null,
			note.notebookName ?? null,
			note.contentHash,
			note.parent_id ?? null,
			note.createdAt ?? null,
			note.updatedAt ?? null,
			now,
			status,
		],
	);
}

export async function upsertIndexState(
	db: any,
	noteId: string,
	contentHash: string,
	status: 'success' | 'failed' | 'pending',
	error: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	const lastIndexedAt = status === 'success' ? now : null;
	const err = error ? error.slice(0, 1000) : null;

	// Use INSERT ON CONFLICT; but preserve last_indexed_at if failed? Spec says last_indexed_at set on success
	if (status === 'success') {
		await run(
			db,
			`INSERT INTO index_state (note_id, content_hash, structural_status, semantic_status, last_indexed_at, error, updated_at)
			 VALUES (?, ?, ?, 'pending', ?, ?, ?)
			 ON CONFLICT(note_id) DO UPDATE SET
			   content_hash = excluded.content_hash,
			   structural_status = excluded.structural_status,
			   last_indexed_at = excluded.last_indexed_at,
			   error = excluded.error,
			   updated_at = excluded.updated_at`,
			[noteId, contentHash, status, lastIndexedAt, err, now],
		);
	} else {
		await run(
			db,
			`INSERT INTO index_state (note_id, content_hash, structural_status, semantic_status, error, updated_at)
			 VALUES (?, ?, ?, 'pending', ?, ?)
			 ON CONFLICT(note_id) DO UPDATE SET
			   content_hash = excluded.content_hash,
			   structural_status = excluded.structural_status,
			   error = excluded.error,
			   updated_at = excluded.updated_at`,
			[noteId, contentHash, status, err, now],
		);
		// Explicitly set last_indexed_at to keep previous? Don't overwrite on failure
		// If row existed, its last_indexed_at stays as before
	}
}

export async function deleteChunksAndEdgesForNote(db: any, noteId: string): Promise<void> {
	await run(db, `DELETE FROM chunks WHERE note_id = ?`, [noteId]);
	const nodeId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE source_id = ? AND layer = 'structural'`, [nodeId]);
	await run(db, `DELETE FROM edges WHERE target_id = ? AND layer = 'structural' AND type = 'backlink'`, [nodeId]);
}
