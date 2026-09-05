import { getDatabase, run, all } from '../storage/db';

export interface DeltaDecision {
	noteId: string;
	contentHash: string;
	shouldReprocess: boolean;
	reason: 'no_state' | 'hash_changed' | 'hash_equal' | 'force' | 'model_changed' | 'deleted';
}

export async function getIndexState(
	db: any,
	noteId: string,
): Promise<{ content_hash: string; structural_status: string } | null> {
	const rows = await all<{ content_hash: string; structural_status: string }>(
		db,
		`SELECT content_hash, structural_status FROM index_state WHERE note_id = ?`,
		[noteId],
	);
	return rows[0] ?? null;
}

export async function shouldReprocess(
	db: any,
	noteId: string,
	currentHash: string,
	options: { force?: boolean; expectedModel?: string } = {},
): Promise<DeltaDecision> {
	if (options.force) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'force' };
	}

	const state = await getIndexState(db, noteId);
	if (!state) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'no_state' };
	}

	if (state.content_hash !== currentHash) {
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'hash_changed' };
	}

	if (state.structural_status !== 'success') {
		// Previously failed or pending, retry
		return { noteId, contentHash: currentHash, shouldReprocess: true, reason: 'hash_changed' };
	}

	// Model change invalidation is checked upstream per batch; if needed, caller can pass force
	return { noteId, contentHash: currentHash, shouldReprocess: false, reason: 'hash_equal' };
}

export async function deleteStaleChunksForNote(db: any, noteId: string): Promise<void> {
	// Deleting chunks CASCADE deletes embeddings and triggers handle FTS
	await run(db, `DELETE FROM chunks WHERE note_id = ?`, [noteId]);
}

export async function deleteStaleStructuralEdges(db: any, noteId: string): Promise<void> {
	const nodeId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE source_id = ? AND layer = 'structural'`, [nodeId]);
	await run(db, `DELETE FROM edges WHERE target_id = ? AND layer = 'structural' AND type = 'backlink'`, [nodeId]);
}

export async function purgeNote(db: any, noteId: string): Promise<void> {
	await run(db, `DELETE FROM chunks WHERE note_id = ?`, [noteId]);
	const nodeId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE source_id = ? OR target_id = ?`, [nodeId, nodeId]);
	await run(db, `DELETE FROM nodes WHERE id = ?`, [nodeId]);
	await run(db, `DELETE FROM index_state WHERE note_id = ?`, [noteId]);
	await run(db, `DELETE FROM notes WHERE id = ?`, [noteId]);
}

export async function findOrphanNotes(db: any, joplinNoteIds: Set<string>): Promise<string[]> {
	const rows = await all<{ id: string }>(db, `SELECT id FROM notes`, []);
	return rows.filter((r) => !joplinNoteIds.has(r.id)).map((r) => r.id);
}
