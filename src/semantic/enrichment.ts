import joplin from 'api';
import { getDatabase, run, all } from '../storage/db';
import { resolveWikiLinkTarget } from '../indexing/graphWriter';

export const enrichmentInFlight = new Set<string>();
const SUPPRESSION_WINDOW_MS = 5000;
const suppressionTimestamps = new Map<string, number>();

export interface EnrichmentSuggestion {
	tags: string[];
	links: string[];
}

export function isEnrichmentInFlight(noteId: string): boolean {
	if (enrichmentInFlight.has(noteId)) return true;
	const ts = suppressionTimestamps.get(noteId);
	if (ts && Date.now() - ts < SUPPRESSION_WINDOW_MS) return true;
	return false;
}

export function registerEnrichmentInFlight(noteId: string): void {
	enrichmentInFlight.add(noteId);
	suppressionTimestamps.set(noteId, Date.now());
	// Remove after debounce window
	setTimeout(() => {
		enrichmentInFlight.delete(noteId);
	}, SUPPRESSION_WINDOW_MS);
}

export function clearEnrichmentInFlight(noteId: string): void {
	enrichmentInFlight.delete(noteId);
}

const MARKER_RE = /<!--\s*echo:enrichment\s+v(\d+)\s+tags=\[(.*?)\]\s+links=\[(.*?)\]\s*-->/;

export function parseEnrichmentMarker(body: string): { version: number; tags: string[]; links: string[] } | null {
	if (!body) return null;
	const match = body.match(MARKER_RE);
	if (!match) return null;
	try {
		const version = parseInt(match[1], 10);
		const tagsRaw = match[2].trim();
		const linksRaw = match[3].trim();
		const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
		const links = linksRaw ? linksRaw.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
		return { version, tags, links };
	} catch {
		return null;
	}
}

export function buildEnrichmentMarker(tags: string[], links: string[], version = 1): string {
	const tagsStr = tags.map((t) => `"${t}"`).join(',');
	const linksStr = links.map((l) => `"${l}"`).join(',');
	return `<!-- echo:enrichment v${version} tags=[${tagsStr}] links=[${linksStr}] -->`;
}

export function stripEnrichmentMarker(body: string): string {
	if (!body) return body;
	return body.replace(MARKER_RE, '').trimEnd();
}

export async function generateSuggestionsForNote(db: any, noteId: string): Promise<EnrichmentSuggestion> {
	// Get top-confidence entities mentioned in this note
	const mentionRows: { entity_id: string; canonical_name: string; confidence: number | null }[] = await all(
		db,
		`SELECT e.id as entity_id, e.canonical_name, e.confidence
		 FROM edges ed
		 JOIN nodes n ON ed.target_id = n.id
		 JOIN entities e ON n.entity_id = e.id
		 WHERE ed.source_id = ? AND ed.type='mention' AND ed.layer='semantic'
		 ORDER BY e.confidence DESC LIMIT 5`,
		[`note:${noteId}`],
	);

	// Fallback if join fails due to node id format: try direct entity lookup via index
	let entities = mentionRows;
	if (entities.length === 0) {
		const altRows: { target_id: string }[] = await all(
			db,
			`SELECT target_id FROM edges WHERE source_id = ? AND type='mention' AND layer='semantic'`,
			[`note:${noteId}`],
		);
		if (altRows.length > 0) {
			const entityIds = altRows.map((r) => r.target_id.replace('entity:', ''));
			if (entityIds.length > 0) {
				const ph = entityIds.map(() => '?').join(',');
				entities = await all(
					db,
					`SELECT id as entity_id, canonical_name, confidence FROM entities WHERE id IN (${ph}) ORDER BY confidence DESC LIMIT 5`,
					entityIds,
				);
			}
		}
	}

	const tags = entities.slice(0, 3).map((e) => e.canonical_name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')).filter(Boolean);

	// For links, get relations where source is one of these entities and target resolves to existing note title
	const relationRows: { target_entity_id: string; relation_type: string; confidence: number | null }[] = await all(
		db,
		`SELECT target_entity_id, relation_type, confidence FROM relations WHERE source_entity_id IN (${entities.map(() => '?').join(',') || "'none'"}) ORDER BY confidence DESC LIMIT 5`,
		entities.map((e) => e.entity_id),
	);

	// Build title index for resolution
	const titleRows: { id: string; title: string }[] = await all(db, `SELECT id, title FROM notes`, []);
	const titleIndex = new Map<string, { id: string; created_time?: number }[]>();
	for (const row of titleRows) {
		const key = (row.title ?? '').toLocaleLowerCase().trim();
		if (!key) continue;
		const list = titleIndex.get(key) ?? [];
		list.push({ id: row.id });
		titleIndex.set(key, list);
	}

	const links: string[] = [];
	for (const rel of relationRows) {
		const targetRows: { canonical_name: string }[] = await all(db, `SELECT canonical_name FROM entities WHERE id = ?`, [rel.target_entity_id]);
		const targetName = targetRows[0]?.canonical_name;
		if (!targetName) continue;
		const resolved = resolveWikiLinkTarget(targetName, titleIndex as any);
		if (resolved) {
			// Use canonical name as link target (should match note title)
			links.push(targetName);
		}
		if (links.length >= 3) break;
	}

	return { tags, links };
}

export async function enrichNote(noteId: string, settings: any): Promise<{ written: boolean; tags: string[]; links: string[] }> {
	if (!settings.enrichmentEnabled) {
		return { written: false, tags: [], links: [] };
	}

	const db = getDatabase();
	const suggestions = await generateSuggestionsForNote(db, noteId);

	// Fetch current note body
	let note: any;
	try {
		note = await (joplin as any).data.get(['notes', noteId], { fields: ['id', 'title', 'body'] });
	} catch {
		return { written: false, tags: [], links: [] };
	}
	if (!note || !note.id) return { written: false, tags: [], links: [] };

	const currentMarker = parseEnrichmentMarker(note.body ?? '');
	if (currentMarker) {
		// Diff: if suggestions match marker, no write
		const sameTags = JSON.stringify(currentMarker.tags.sort()) === JSON.stringify(suggestions.tags.sort());
		const sameLinks = JSON.stringify(currentMarker.links.sort()) === JSON.stringify(suggestions.links.sort());
		if (sameTags && sameLinks) {
			return { written: false, tags: suggestions.tags, links: suggestions.links };
		}
	}

	// Build new body with marker and enrichment content
	// Tags as hashtag at end? For simplicity, append tags as hashtags and links as [[links]] before marker
	let newBody = stripEnrichmentMarker(note.body ?? '');

	// Remove previous enrichment tags/links if marker existed? For idempotency, we just replace marker and re-add suggestions
	// Append suggestions if not already present
	if (suggestions.tags.length > 0) {
		const tagsLine = suggestions.tags.map((t) => `#${t}`).join(' ');
		if (!newBody.includes(tagsLine)) newBody = `${newBody.trimEnd()}\n\n${tagsLine}`;
	}
	if (suggestions.links.length > 0) {
		const linksLine = suggestions.links.map((l) => `[[${l}]]`).join(' ');
		if (!newBody.includes(linksLine)) newBody = `${newBody.trimEnd()}\n\n${linksLine}`;
	}

	const marker = buildEnrichmentMarker(suggestions.tags, suggestions.links);
	newBody = `${newBody.trimEnd()}\n\n${marker}`;

	// Loop suppression: register before write
	registerEnrichmentInFlight(noteId);
	try {
		await (joplin as any).data.put(['notes', noteId], null, { body: newBody });

		// Update structural graph with source='enrichment' edges
		const noteNodeId = `note:${noteId}`;
		const now = new Date().toISOString();
		// For each tag, create tag node with source enrichment? Simplified: create edges with source enrichment
		for (const tag of suggestions.tags) {
			const tagNodeId = `tag:enrichment:${tag.toLowerCase()}`;
			await run(
				db,
				`INSERT OR IGNORE INTO nodes (id, layer, kind, label, created_at, updated_at, source) VALUES (?, 'structural', 'entity', ?, ?, ?, 'enrichment')`,
				[tagNodeId, tag, now, now],
			);
			const edgeId = `${noteNodeId}->${tagNodeId}:tag`;
			await run(
				db,
				`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at, source) VALUES (?, 'structural', ?, ?, 'tag', 1.0, ?, 'enrichment')`,
				[edgeId, noteNodeId, tagNodeId, now],
			);
		}
		for (const link of suggestions.links) {
			const targetRows: { id: string }[] = await all(db, `SELECT id FROM notes WHERE title = ? COLLATE NOCASE`, [link]);
			const targetId = targetRows[0]?.id;
			if (!targetId) continue;
			const targetNodeId = `note:${targetId}`;
			const edgeId = `${noteNodeId}->${targetNodeId}:link`;
			await run(
				db,
				`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at, source) VALUES (?, 'structural', ?, ?, 'link', 1.0, ?, 'enrichment')`,
				[edgeId, noteNodeId, targetNodeId, now],
			);
		}
	} finally {
		// Keep in flight for suppression window; removal via timeout
	}

	return { written: true, tags: suggestions.tags, links: suggestions.links };
}

export async function removeEnrichmentForNote(noteId: string): Promise<void> {
	const db = getDatabase();
	const sourceId = `note:${noteId}`;
	await run(db, `DELETE FROM edges WHERE source='enrichment' AND source_id = ?`, [sourceId]);
	// Also delete backlink enrichment edges where target is this note?
	await run(db, `DELETE FROM edges WHERE source='enrichment' AND target_id = ?`, [sourceId]);
	// Remove marker from note body if enrichment disabled
	try {
		const note: any = await (joplin as any).data.get(['notes', noteId], { fields: ['body'] });
		if (note && note.body && parseEnrichmentMarker(note.body)) {
			const newBody = stripEnrichmentMarker(note.body);
			registerEnrichmentInFlight(noteId);
			await (joplin as any).data.put(['notes', noteId], null, { body: newBody });
		}
	} catch {}
}
