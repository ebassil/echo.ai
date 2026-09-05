import { createHash } from 'crypto';
import { run, all } from '../storage/db';
import { withPerNoteTransaction } from '../indexing/persist';
import { DEFAULT_EVIDENCE_CONFIDENCE, confidenceFromCount } from './evidence';
import { canonicalizeAndPersist } from './canonicalize';
import type { ExtractionResult } from '../llm/provider';
import type { LLMProvider } from '../llm/provider';

export interface SemanticPersistOptions {
	provider?: LLMProvider;
	canonicalizationMode: 'exact' | 'embedding';
	canonicalSimilarity: number;
	extractionModel: string;
	embeddingCache?: Map<string, number[]>;
}

export async function persistSemanticForNote(
	db: any,
	note: { id: string; title: string },
	chunks: { id: string; content: string }[],
	extraction: ExtractionResult,
	options: SemanticPersistOptions,
): Promise<{ entitiesCreated: number; relationsCreated: number }> {
	let entitiesCreated = 0;
	let relationsCreated = 0;

	await withPerNoteTransaction(db, async () => {
		// Delete old evidence and mention edges for this note
		const sourceId = `note:${note.id}`;
		// Delete relation_evidence for this note
		await run(db, `DELETE FROM relation_evidence WHERE note_id = ?`, [note.id]);
		// Delete mention edges
		await run(db, `DELETE FROM edges WHERE layer='semantic' AND type='mention' AND source_id = ?`, [sourceId]);
		// Note: relation edges for zero-evidence will be deleted via helper after inserts? But we need to clean zero-evidence relations now after delete
		// We will handle zero-evidence cleanup after re-insertion below via deleteZeroEvidence helper

		// Canonicalize entities and persist
		const entityIdMap = await canonicalizeAndPersist(db, extraction.entities, {
			mode: options.canonicalizationMode,
			similarityThreshold: options.canonicalSimilarity,
			provider: options.provider,
			embeddingCache: options.embeddingCache,
		});

		// For tracking which relations are newly created
		const existingRelationIds = new Set<string>();

		// Helper to get entity id for a name
		function getEntityIdForName(name: string): string | null {
			const norm = name.normalize('NFC').trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
			return entityIdMap.get(norm) ?? null;
		}

		// Also need mapping for relation from/to to entity id via DB query if not in current batch but existing entity
		// Since entityIdMap only contains entities from this extraction, for relations that reference existing entities not in this batch, we need to lookup
		async function resolveEntityId(name: string): Promise<string | null> {
			const norm = name.normalize('NFC').trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
			const mapped = entityIdMap.get(norm);
			if (mapped) return mapped;
			// Lookup existing entity by canonical_name
			const rows: { id: string }[] = await all(db, `SELECT id FROM entities WHERE canonical_name = ?`, [norm]);
			return rows[0]?.id ?? null;
		}

		// Determine chunk ids for this note (for evidence)
		const chunkIds = chunks.map((c) => c.id);
		if (chunkIds.length === 0 && extraction.relations.length > 0) {
			// If no chunks (empty note?), create synthetic chunk id for evidence
			// Use note id as chunk id fallback
			chunkIds.push(`${note.id}:0`);
		}

		for (const rel of extraction.relations) {
			const sourceId = await resolveEntityId(rel.from);
			const targetId = await resolveEntityId(rel.to);
			if (!sourceId || !targetId) {
				// Skip relation if entities not resolved (should not happen after canonicalization)
				continue;
			}
			const relationId = makeRelationId(sourceId, targetId, rel.type);
			const now = new Date().toISOString();
			const confidence = rel.confidence ?? DEFAULT_EVIDENCE_CONFIDENCE;

			// Check if relation exists
			const existing: { id: string; confidence: number | null }[] = await all(
				db,
				`SELECT id, confidence FROM relations WHERE id = ?`,
				[relationId],
			);
			if (existing.length === 0) {
				await run(
					db,
					`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence, evidence_chunk_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[relationId, sourceId, targetId, rel.type, confidence, chunkIds[0] ?? null, now, now],
				);
				relationsCreated++;
			} else {
				// Existing relation: keep existing confidence, will recompute after evidence insertion
			}

			// Insert evidence rows for each chunk that evidenced this relation
			// For MVP, we evidence with all chunks of this note (or first chunk)
			// To be more accurate, we should evidence with each chunk content that contains both entities? But we don't have per-chunk entity mapping.
			// Simplify: use first chunk id for evidence (or all chunks if we have chunk-level extraction we could map)
			// Here we use first chunk id + note_id
			const primaryChunkId = chunkIds[0];
			await run(
				db,
				`INSERT OR IGNORE INTO relation_evidence (relation_id, chunk_id, note_id, created_at) VALUES (?, ?, ?, ?)`,
				[relationId, primaryChunkId, note.id, now],
			);

			// Recompute confidence based on evidence count
			const cntRows: { cnt: number }[] = await all(
				db,
				`SELECT COUNT(*) as cnt FROM relation_evidence WHERE relation_id = ?`,
				[relationId],
			);
			const count = cntRows[0]?.cnt ?? 1;
			// Use confidenceFromCount if no per-evidence confidence custom; otherwise compute with stored confidences
			// For now use count-based
			const recomputed = confidenceFromCount(count);
			// If relation had custom confidence, blend? We'll take max of stored and recomputed
			const effectiveConfidence = Math.max(recomputed, confidence);
			await run(db, `UPDATE relations SET confidence = ?, updated_at = ? WHERE id = ?`, [effectiveConfidence, now, relationId]);

			// Materialize relation edge
			const sourceNodeId = `entity:${sourceId}`;
			const targetNodeId = `entity:${targetId}`;
			const edgeId = `${sourceNodeId}->${targetNodeId}:relation`;
			await run(
				db,
				`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at, source) VALUES (?, 'semantic', ?, ?, 'relation', ?, ?, 'joplin')`,
				[edgeId, sourceNodeId, targetNodeId, effectiveConfidence, now],
			);
			// Update weight if edge already existed
			await run(db, `UPDATE edges SET weight = ? WHERE id = ?`, [effectiveConfidence, edgeId]);
		}

		// Materialize mention edges: one per (note, entity) where entity was mentioned
		// Use entityIdMap values (entities created/merged in this note)
		const now2 = new Date().toISOString();
		const noteNodeId = `note:${note.id}`;
		// Ensure note node exists (might already exist from structural indexing, but ensure)
		await run(
			db,
			`INSERT INTO nodes (id, layer, kind, label, note_id, created_at, updated_at, source)
			 VALUES (?, 'semantic', 'note', ?, ?, ?, ?, 'joplin')
			 ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
			[noteNodeId, note.title ?? note.id, note.id, now2, now2],
		);

		for (const entityId of entityIdMap.values()) {
			const entityNodeId = `entity:${entityId}`;
			const edgeId = `${noteNodeId}->${entityNodeId}:mention`;
			await run(
				db,
				`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at, source) VALUES (?, 'semantic', ?, ?, 'mention', 1.0, ?, 'joplin')`,
				[edgeId, noteNodeId, entityNodeId, now2],
			);
		}

		// Count entities created in this transaction (approx via map size)
		entitiesCreated = entityIdMap.size;

		// Clean up zero-evidence relations (those that lost all evidence due to deletion)
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
			const srcNode = `entity:${rel.source_entity_id}`;
			const tgtNode = `entity:${rel.target_entity_id}`;
			await run(
				db,
				`DELETE FROM edges WHERE layer='semantic' AND type='relation' AND source_id = ? AND target_id = ?`,
				[srcNode, tgtNode],
			);
			await run(db, `DELETE FROM relations WHERE id = ?`, [rel.id]);
		}

		// Upsert index_state
		await upsertSemanticIndexState(db, note.id, options.extractionModel, 'success', null);
	});
	return { entitiesCreated, relationsCreated };
}

function makeRelationId(sourceId: string, targetId: string, type: string): string {
	const normalizedType = type.trim().toLocaleLowerCase();
	const raw = `${sourceId}|${targetId}|${normalizedType}`;
	const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
	return `rel_${hash.slice(0, 16)}`;
}

export async function upsertSemanticIndexState(
	db: any,
	noteId: string,
	extractionModel: string,
	status: 'success' | 'failed' | 'pending',
	error: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	const lastIndexedAt = status === 'success' ? now : null;
	const err = error ? error.slice(0, 1000) : null;

	// Ensure extraction_model column exists
	try {
		const cols: { name: string }[] = await all(db, `SELECT name FROM pragma_table_info('index_state')`, []);
		const hasModel = cols.some((c) => c.name === 'extraction_model');
		if (!hasModel) {
			await run(db, `ALTER TABLE index_state ADD COLUMN extraction_model TEXT`);
		}
	} catch {}

	// Need to preserve structural_status
	const existing: { content_hash: string; structural_status: string }[] = await all(
		db,
		`SELECT content_hash, structural_status FROM index_state WHERE note_id = ?`,
		[noteId],
	);
	let contentHash = '';
	let structuralStatus = 'pending';
	if (existing.length > 0) {
		contentHash = existing[0].content_hash;
		structuralStatus = existing[0].structural_status ?? 'pending';
	} else {
		// Need to get content_hash from notes
		const noteRows: { content_hash: string }[] = await all(db, `SELECT content_hash FROM notes WHERE id = ?`, [noteId]);
		contentHash = noteRows[0]?.content_hash ?? '';
	}

	if (status === 'success') {
		await run(
			db,
			`INSERT INTO index_state (note_id, content_hash, structural_status, semantic_status, last_indexed_at, error, updated_at, extraction_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(note_id) DO UPDATE SET
			   semantic_status = excluded.semantic_status,
			   last_indexed_at = excluded.last_indexed_at,
			   error = excluded.error,
			   updated_at = excluded.updated_at,
			   extraction_model = excluded.extraction_model`,
			[noteId, contentHash, structuralStatus, status, lastIndexedAt, err, now, extractionModel],
		);
	} else {
		await run(
			db,
			`INSERT INTO index_state (note_id, content_hash, structural_status, semantic_status, error, updated_at, extraction_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(note_id) DO UPDATE SET
			   semantic_status = excluded.semantic_status,
			   error = excluded.error,
			   updated_at = excluded.updated_at,
			   extraction_model = excluded.extraction_model`,
			[noteId, contentHash, structuralStatus, status, err, now, extractionModel],
		);
	}
}

export async function deleteSemanticForNote(db: any, noteId: string): Promise<void> {
	await withPerNoteTransaction(db, async () => {
		await run(db, `DELETE FROM relation_evidence WHERE note_id = ?`, [noteId]);
		const sourceId = `note:${noteId}`;
		await run(db, `DELETE FROM edges WHERE layer='semantic' AND type='mention' AND source_id = ?`, [sourceId]);
		// Clean zero-evidence relations
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
			const srcNode = `entity:${rel.source_entity_id}`;
			const tgtNode = `entity:${rel.target_entity_id}`;
			await run(db, `DELETE FROM edges WHERE layer='semantic' AND type='relation' AND source_id = ? AND target_id = ?`, [
				srcNode,
				tgtNode,
			]);
			await run(db, `DELETE FROM relations WHERE id = ?`, [rel.id]);
		}
	});
}
