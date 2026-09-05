import { createHash } from 'crypto';
import { run, all } from '../storage/db';
import type { Entity } from '../llm/provider';
import type { LLMProvider } from '../llm/provider';

export function normalize(name: string): string {
	if (typeof name !== 'string') return '';
	// NFC → trim → toLocaleLowerCase → collapse whitespace → strip punctuation
	let s = name.normalize('NFC');
	s = s.trim();
	s = s.toLocaleLowerCase();
	s = s.replace(/\s+/g, ' ');
	// Strip leading/trailing punctuation (keep letters/numbers)
	// Use unicode property escapes
	s = s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

function makeEntityId(canonicalName: string): string {
	// Deterministic ID from canonical name
	const hash = createHash('sha256').update(canonicalName, 'utf8').digest('hex');
	return `ent_${hash.slice(0, 16)}`;
}

export interface CanonicalizationOptions {
	mode: 'exact' | 'embedding';
	similarityThreshold: number; // default 0.85
	provider?: LLMProvider;
	// Per-run cache: normalized -> vector
	embeddingCache?: Map<string, number[]>;
}

export interface PersistedEntity {
	id: string;
	canonicalName: string;
	aliases: string[];
	type: string;
	confidence: number | null;
}

export function groupExact(entities: Entity[]): Map<string, { canonicalForm: string; aliases: Set<string>; type: string; confidence: number | null; count: number }> {
	const map = new Map<string, { canonicalForm: string; aliases: Set<string>; type: string; confidence: number | null; count: number }>();
	for (const e of entities) {
		const norm = normalize(e.name);
		if (!norm) continue;
		const existing = map.get(norm);
		if (!existing) {
			map.set(norm, {
				canonicalForm: norm,
				aliases: new Set([e.name.trim()]),
				type: e.type ?? 'unknown',
				confidence: e.confidence ?? null,
				count: 1,
			});
		} else {
			existing.aliases.add(e.name.trim());
			// Keep first type, but upgrade confidence to max
			if (e.confidence != null && (existing.confidence == null || e.confidence > existing.confidence)) {
				existing.confidence = e.confidence;
			}
			existing.count++;
		}
	}
	return map;
}

export async function persistExact(
	db: any,
	grouped: Map<string, { canonicalForm: string; aliases: Set<string>; type: string; confidence: number | null }>,
): Promise<Map<string, string>> {
	// Returns mapping normalized -> entityId
	const result = new Map<string, string>();
	const now = new Date().toISOString();

	for (const [norm, info] of grouped) {
		const entityId = makeEntityId(norm);
		const canonicalName = norm; // per spec first-seen normalized
		const aliasesJson = JSON.stringify(Array.from(info.aliases));

		// Check existing
		const existingRows: { id: string; aliases: string | null; confidence: number | null; canonical_name: string }[] = await all(
			db,
			`SELECT id, canonical_name, aliases, confidence FROM entities WHERE canonical_name = ?`,
			[canonicalName],
		);
		if (existingRows.length > 0) {
			const existing = existingRows[0];
			// Merge aliases
			let existingAliases: string[] = [];
			try {
				existingAliases = existing.aliases ? JSON.parse(existing.aliases) : [];
			} catch {
				existingAliases = [];
			}
			const union = new Set([...existingAliases, ...Array.from(info.aliases)]);
			const mergedAliasesJson = JSON.stringify(Array.from(union));
			const mergedConfidence =
				info.confidence != null && existing.confidence != null
					? Math.max(info.confidence, existing.confidence)
					: info.confidence ?? existing.confidence;
			await run(
				db,
				`UPDATE entities SET aliases = ?, confidence = ?, updated_at = ? WHERE id = ?`,
				[mergedAliasesJson, mergedConfidence, now, existing.id],
			);
			// Also ensure nodes bridge exists and rewrite if needed
			await ensureEntityNode(db, existing.id, canonicalName, now);
			// If incoming id differs from existing id (should not happen as id deterministic), rewrite nodes
			if (existing.id !== entityId) {
				await run(db, `UPDATE nodes SET entity_id = ? WHERE entity_id = ?`, [existing.id, entityId]);
			}
			result.set(norm, existing.id);
		} else {
			// Insert new
			await run(
				db,
				`INSERT OR IGNORE INTO entities (id, canonical_name, type, aliases, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[entityId, canonicalName, info.type, aliasesJson, info.confidence, now, now],
			);
			// Handle race where another insert just happened (IGNORE)
			// Re-query to get actual id
			const rows: { id: string }[] = await all(db, `SELECT id FROM entities WHERE canonical_name = ?`, [canonicalName]);
			const finalId = rows[0]?.id ?? entityId;
			await ensureEntityNode(db, finalId, canonicalName, now);
			result.set(norm, finalId);
		}
	}
	return result;
}

async function ensureEntityNode(db: any, entityId: string, label: string, now: string): Promise<void> {
	const nodeId = `entity:${entityId}`;
	await run(
		db,
		`INSERT INTO nodes (id, layer, kind, label, entity_id, created_at, updated_at, source)
		 VALUES (?, 'semantic', 'entity', ?, ?, ?, ?, 'joplin')
		 ON CONFLICT(id) DO UPDATE SET label = excluded.label, entity_id = excluded.entity_id, updated_at = excluded.updated_at`,
		[nodeId, label, entityId, now, now],
	);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function persistWithEmbedding(
	db: any,
	grouped: Map<string, { canonicalForm: string; aliases: Set<string>; type: string; confidence: number | null }>,
	options: CanonicalizationOptions,
): Promise<Map<string, string>> {
	if (!options.provider) {
		// Fallback to exact
		return persistExact(db, grouped);
	}
	const provider = options.provider;
	const threshold = options.similarityThreshold ?? 0.85;
	const cache = options.embeddingCache ?? new Map<string, number[]>();
	const now = new Date().toISOString();

	// Load existing entities
	const existingEntities: { id: string; canonical_name: string; aliases: string | null; confidence: number | null }[] = await all(
		db,
		`SELECT id, canonical_name, aliases, confidence FROM entities`,
		[],
	);

	// Pre-embed existing entities (cached)
	for (const ent of existingEntities) {
		const norm = normalize(ent.canonical_name);
		if (!cache.has(norm)) {
			try {
				const vectors = await provider.embeddings([norm]);
				if (vectors[0]) cache.set(norm, vectors[0]);
			} catch {
				// ignore embedding failure for this entity
			}
		}
	}

	const result = new Map<string, string>();

	for (const [norm, info] of grouped) {
		// Embed incoming normalized name
		let incomingVector: number[] | null = cache.get(norm) ?? null;
		if (!incomingVector) {
			try {
				const vectors = await provider.embeddings([norm]);
				incomingVector = vectors[0] ?? null;
				if (incomingVector) cache.set(norm, incomingVector);
			} catch {
				incomingVector = null;
			}
		}

		let bestMatch: { entity: typeof existingEntities[0]; similarity: number } | null = null;

		if (incomingVector) {
			for (const ent of existingEntities) {
				const entNorm = normalize(ent.canonical_name);
				const entVector = cache.get(entNorm);
				if (!entVector) continue;
				const sim = cosineSimilarity(incomingVector, entVector);
				if (sim > threshold && (bestMatch == null || sim > bestMatch.similarity)) {
					bestMatch = { entity: ent, similarity: sim };
				}
			}
		}

		if (bestMatch) {
			// Merge into existing entity
			const target = bestMatch.entity;
			let existingAliases: string[] = [];
			try {
				existingAliases = target.aliases ? JSON.parse(target.aliases) : [];
			} catch {
				existingAliases = [];
			}
			const union = new Set([...existingAliases, ...Array.from(info.aliases)]);
			const mergedAliasesJson = JSON.stringify(Array.from(union));
			const mergedConfidence =
				info.confidence != null && target.confidence != null
					? Math.max(info.confidence, target.confidence)
					: info.confidence ?? target.confidence;
			await run(
				db,
				`UPDATE entities SET aliases = ?, confidence = ?, updated_at = ? WHERE id = ?`,
				[mergedAliasesJson, mergedConfidence, now, target.id],
			);
			await ensureEntityNode(db, target.id, target.canonical_name, now);
			// Rewrite absorbed ids if this incoming would have been new entity but merged: no new id to rewrite
			// However if there is duplicate incoming that would create same norm but different entity previously, handle alias union already.
			// Need to handle case where incoming norm equals existing canonical? Already merged above.

			// For future incoming groups in same run that might match this entity, update cache list
			// Add this norm's vector to existing mapping to avoid re-embedding
			result.set(norm, target.id);
		} else {
			// No match, insert as new via exact logic
			const singleMap = new Map([[norm, info]]);
			const subResult = await persistExact(db, singleMap);
			const newId = subResult.get(norm);
			if (newId) {
				// Add to existingEntities list for subsequent similarity checks in this run
				existingEntities.push({
					id: newId,
					canonical_name: norm,
					aliases: JSON.stringify(Array.from(info.aliases)),
					confidence: info.confidence,
				});
				result.set(norm, newId);
			}
		}
	}

	return result;
}

export async function canonicalizeAndPersist(
	db: any,
	entities: Entity[],
	options: CanonicalizationOptions,
): Promise<Map<string, string>> {
	const grouped = groupExact(entities);
	if (options.mode === 'embedding') {
		return persistWithEmbedding(db, grouped, options);
	}
	return persistExact(db, grouped);
}

/**
 * Rewrite entity_id for absorbed entities (when merging two existing entities due to embedding similarity beyond current run).
 * Used when we detect that two existing entities should merge.
 */
export async function mergeEntities(
	db: any,
	survivingId: string,
	absorbedId: string,
): Promise<void> {
	if (survivingId === absorbedId) return;
	const now = new Date().toISOString();
	// Merge aliases
	const rows: { aliases: string | null; confidence: number | null }[] = await all(
		db,
		`SELECT aliases, confidence FROM entities WHERE id IN (?, ?)`,
		[survivingId, absorbedId],
	);
	if (rows.length < 2) return;
	// Fetch both
	const survivingRows: { aliases: string | null; canonical_name: string }[] = await all(
		db,
		`SELECT aliases, canonical_name FROM entities WHERE id = ?`,
		[survivingId],
	);
	const absorbedRows: { aliases: string | null }[] = await all(db, `SELECT aliases FROM entities WHERE id = ?`, [absorbedId]);
	const survivingAliases = survivingRows[0]?.aliases ? JSON.parse(survivingRows[0].aliases!) : [];
	const absorbedAliases = absorbedRows[0]?.aliases ? JSON.parse(absorbedRows[0].aliases!) : [];
	const union = JSON.stringify(Array.from(new Set([...survivingAliases, ...absorbedAliases])));
	await run(db, `UPDATE entities SET aliases = ?, updated_at = ? WHERE id = ?`, [union, now, survivingId]);
	// Rewrite nodes
	await run(db, `UPDATE nodes SET entity_id = ? WHERE entity_id = ?`, [survivingId, absorbedId]);
	// Rewrite relations source/target
	await run(db, `UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ?`, [survivingId, absorbedId]);
	await run(db, `UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ?`, [survivingId, absorbedId]);
	// Rewrite edges that reference absorbed entity nodes (fallback)
	await run(db, `DELETE FROM nodes WHERE entity_id = ?`, [absorbedId]); // Will cascade? Actually nodes for absorbed entity should be deleted
	await run(db, `DELETE FROM entities WHERE id = ?`, [absorbedId]);
}
