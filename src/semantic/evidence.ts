import { run, all } from '../storage/db';

export const DEFAULT_EVIDENCE_CONFIDENCE = 0.6;

/**
 * Compute confidence via 1 - product(1 - c_i).
 * Each c_i is clamped to [0,1] and defaults to DEFAULT_EVIDENCE_CONFIDENCE when undefined.
 */
export function computeConfidence(confidences: (number | undefined | null)[]): number {
	if (confidences.length === 0) return 0;
	let product = 1;
	for (const cRaw of confidences) {
		const c = cRaw == null ? DEFAULT_EVIDENCE_CONFIDENCE : Number(cRaw);
		const clamped = Math.min(Math.max(isFinite(c) ? c : DEFAULT_EVIDENCE_CONFIDENCE, 0), 0.99);
		// Cap at 0.99 to avoid product zero causing confidence 1.0 which saturates; but allow 1.0 if explicitly set
		// Actually allow 1.0 gives confidence 1, so cap at 1.
		const effective = Math.min(Math.max(c, 0), 1);
		product *= 1 - (isFinite(effective) ? effective : DEFAULT_EVIDENCE_CONFIDENCE);
	}
	const confidence = 1 - product;
	// Clamp to [0,1]
	return Math.min(Math.max(confidence, 0), 1);
}

/**
 * Confidence derived purely from evidence count assuming default confidence per evidence.
 * Equivalent to computeConfidence(Array(count).fill(DEFAULT_EVIDENCE_CONFIDENCE))
 */
export function confidenceFromCount(count: number): number {
	if (count <= 0) return 0;
	return 1 - Math.pow(1 - DEFAULT_EVIDENCE_CONFIDENCE, count);
}

/**
 * Add relation_evidence rows. If chunk already evidences relation, ignored (PK).
 * After insert, recompute confidence.
 */
export async function addRelationEvidence(
	db: any,
	relationId: string,
	chunkId: string,
	noteId: string,
	options: { confidence?: number } = {},
): Promise<void> {
	const now = new Date().toISOString();
	// Insert; ignore duplicate PK
	await run(
		db,
		`INSERT OR IGNORE INTO relation_evidence (relation_id, chunk_id, note_id, created_at) VALUES (?, ?, ?, ?)`,
		[relationId, chunkId, noteId, now],
	);
	await recomputeRelationConfidence(db, relationId);
}

/**
 * Batch add evidence for a relation across multiple chunks.
 */
export async function addRelationEvidences(
	db: any,
	entries: { relationId: string; chunkId: string; noteId: string; confidence?: number }[],
): Promise<void> {
	if (entries.length === 0) return;
	const now = new Date().toISOString();
	for (const e of entries) {
		await run(
			db,
			`INSERT OR IGNORE INTO relation_evidence (relation_id, chunk_id, note_id, created_at) VALUES (?, ?, ?, ?)`,
			[e.relationId, e.chunkId, e.noteId, now],
		);
	}
	// Recompute for distinct relationIds
	const distinct = new Set(entries.map((e) => e.relationId));
	for (const relId of distinct) {
		await recomputeRelationConfidence(db, relId);
	}
}

/**
 * Remove evidence rows by chunk ids for a given relation.
 */
export async function removeRelationEvidenceForChunks(
	db: any,
	relationId: string,
	chunkIds: string[],
): Promise<void> {
	if (chunkIds.length === 0) return;
	const placeholders = chunkIds.map(() => '?').join(',');
	await run(
		db,
		`DELETE FROM relation_evidence WHERE relation_id = ? AND chunk_id IN (${placeholders})`,
		[relationId, ...chunkIds],
	);
	await recomputeRelationConfidence(db, relationId);
}

/**
 * Delete all evidence for a note's chunks (scoped delete).
 * Also deletes mention edges for that note.
 */
export async function deleteEvidenceForNote(db: any, noteId: string): Promise<void> {
	// Delete relation_evidence where note_id = ?
	await run(db, `DELETE FROM relation_evidence WHERE note_id = ?`, [noteId]);

	// Find relations that now have zero evidence and delete them + edges
	await deleteZeroEvidenceRelations(db);
}

/**
 * Delete mention edges for a note.
 */
export async function deleteMentionEdgesForNote(db: any, noteId: string): Promise<void> {
	const sourceId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE layer='semantic' AND type='mention' AND source_id = ?`, [sourceId]);
}

/**
 * Scoped delete for a note: evidence + mention edges + recompute confidences for affected relations
 */
export async function deleteSemanticForNote(db: any, noteId: string): Promise<void> {
	// Need affected relation ids before delete
	const affected: { relation_id: string }[] = await all(
		db,
		`SELECT DISTINCT relation_id FROM relation_evidence WHERE note_id = ?`,
		[noteId],
	);
	await run(db, `DELETE FROM relation_evidence WHERE note_id = ?`, [noteId]);
	const sourceId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE layer='semantic' AND type='mention' AND source_id = ?`, [sourceId]);
	// Also delete evidence for chunks of this note already cascades, but above covers relation_evidence.

	// Recompute confidence for affected relations that still exist
	for (const row of affected) {
		// Relation may have been deleted already if zero evidence, but recompute will handle
		const exists = await all(db, `SELECT id FROM relations WHERE id = ?`, [row.relation_id]);
		if (exists.length > 0) {
			await recomputeRelationConfidence(db, row.relation_id);
		}
	}
	await deleteZeroEvidenceRelations(db);
}

/**
 * Recompute confidence for a single relation based on evidence count.
 * If table has confidence column per evidence (optional), we would query it; otherwise count-based.
 */
export async function recomputeRelationConfidence(db: any, relationId: string): Promise<void> {
	const rows = await all<{ cnt: number }>(
		db,
		`SELECT COUNT(*) as cnt FROM relation_evidence WHERE relation_id = ?`,
		[relationId],
	);
	const count = rows[0]?.cnt ?? 0;
	if (count === 0) {
		// Delete zero-evidence relation and its edge
		await run(db, `DELETE FROM relations WHERE id = ?`, [relationId]);
		// Edges for relations are keyed by nodes; we store relation edge as type='relation' with source/target = entity nodes
		// Need to find entity nodes for this relation to delete edge? Instead delete by scanning edges that correspond to this relation via relation id encoding?
		// Our edges don't directly reference relation_id, but we can delete edges where both source and target map to entities of this relation.
		// Simpler: we encoded edge id as `entitySource->entityTarget:relation` ; but we can delete via relations source/target entities.
		// Instead we can delete edges for that relation by looking up relation source/target before deletion, but we already deleted relation.
		// To handle, query before deletion; here we handle edge deletion separately after counting zero.
		// If relation was just deleted, we need to delete its edge using previously fetched entities. So do it before delete; handle in deleteZeroEvidenceRelations.
		// For now, if count==0 but relation still exists, delete edge via helper.
		// Need to fetch relation entities if still exists (but we just checked count, not yet deleted). Let's fetch relation row first.
		const relRows = await all<{ source_entity_id: string; target_entity_id: string }>(
			db,
			`SELECT source_entity_id, target_entity_id FROM relations WHERE id = ?`,
			[relationId],
		);
		if (relRows.length > 0) {
			const rel = relRows[0];
			const sourceNodeId = `entity:${rel.source_entity_id}`;
			const targetNodeId = `entity:${rel.target_entity_id}`;
			// Alternative node id format: `entity:${id}` or based on nodes.id? In persist we will define; handle both
			await run(
				db,
				`DELETE FROM edges WHERE layer='semantic' AND type='relation' AND source_id IN (?, ?) AND target_id IN (?, ?)`,
				[sourceNodeId, rel.source_entity_id, targetNodeId, rel.target_entity_id],
			);
			// Fallback: delete by edge id pattern
			await run(db, `DELETE FROM relations WHERE id = ?`, [relationId]);
		}
		return;
	}
	// Try to fetch per-evidence confidences if column exists
	let confidences: number[] = [];
	try {
		// Check if confidence column exists
		const cols: { name: string }[] = await all(db, `SELECT name FROM pragma_table_info('relation_evidence')`, []);
		const hasConfidence = cols.some((c) => c.name === 'confidence');
		if (hasConfidence) {
			const cRows: { confidence: number | null }[] = await all(
				db,
				`SELECT confidence FROM relation_evidence WHERE relation_id = ?`,
				[relationId],
			);
			confidences = cRows.map((r) => r.confidence ?? DEFAULT_EVIDENCE_CONFIDENCE);
		} else {
			confidences = Array(count).fill(DEFAULT_EVIDENCE_CONFIDENCE);
		}
	} catch {
		confidences = Array(count).fill(DEFAULT_EVIDENCE_CONFIDENCE);
	}

	const confidence = computeConfidence(confidences);
	const now = new Date().toISOString();
	await run(db, `UPDATE relations SET confidence = ?, updated_at = ? WHERE id = ?`, [confidence, now, relationId]);

	// Update edge weight to match confidence
	try {
		const relRows = await all<{ source_entity_id: string; target_entity_id: string }>(
			db,
			`SELECT source_entity_id, target_entity_id FROM relations WHERE id = ?`,
			[relationId],
		);
		if (relRows.length > 0) {
			const rel = relRows[0];
			// Edge source/target are entity node ids; update weight
			const sourceNodeId = `entity:${rel.source_entity_id}`;
			const targetNodeId = `entity:${rel.target_entity_id}`;
			await run(
				db,
				`UPDATE edges SET weight = ? WHERE layer='semantic' AND type='relation' AND (source_id = ? OR source_id = ?) AND (target_id = ? OR target_id = ?)`,
				[confidence, sourceNodeId, rel.source_entity_id, targetNodeId, rel.target_entity_id],
			);
		}
	} catch {
		// ignore edge weight update failure
	}
}

/**
 * Delete all relations with zero evidence and their relation edges.
 */
export async function deleteZeroEvidenceRelations(db: any): Promise<void> {
	const zeroRelations: { id: string; source_entity_id: string; target_entity_id: string }[] = await all(
		db,
		`SELECT r.id, r.source_entity_id, r.target_entity_id
		 FROM relations r
		 LEFT JOIN relation_evidence re ON re.relation_id = r.id
		 GROUP BY r.id
		 HAVING COUNT(re.relation_id) = 0`,
		[],
	);
	for (const rel of zeroRelations) {
		const sourceNodeId = `entity:${rel.source_entity_id}`;
		const targetNodeId = `entity:${rel.target_entity_id}`;
		await run(
			db,
			`DELETE FROM edges WHERE layer='semantic' AND type='relation' AND (source_id = ? OR source_id = ?) AND (target_id = ? OR target_id = ?)`,
			[sourceNodeId, rel.source_entity_id, targetNodeId, rel.target_entity_id],
		);
		await run(db, `DELETE FROM relations WHERE id = ?`, [rel.id]);
	}
}

/**
 * Get evidence count for a relation
 */
export async function getEvidenceCount(db: any, relationId: string): Promise<number> {
	const rows = await all<{ cnt: number }>(db, `SELECT COUNT(*) as cnt FROM relation_evidence WHERE relation_id = ?`, [
		relationId,
	]);
	return rows[0]?.cnt ?? 0;
}
