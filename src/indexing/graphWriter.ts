import { getDatabase, run, all } from '../storage/db';
import { extractWikiLinks } from './extractors/links';
import type { JoplinTag } from './extractors/tags';

export interface GraphWriteResult {
	nodesUpserted: number;
	edgesCreated: number;
	unresolvedLinks: number;
}

function noteNodeId(noteId: string): string {
	return `note:${noteId}`;
}

function tagNodeId(tagId: string): string {
	return `tag:${tagId}`;
}

function edgeId(sourceId: string, targetId: string, type: string): string {
	return `${sourceId}->${targetId}:${type}`;
}

export async function upsertNoteNode(
	db: any,
	noteId: string,
	title: string,
): Promise<void> {
	const id = noteNodeId(noteId);
	const now = new Date().toISOString();
	await run(
		db,
		`INSERT INTO nodes (id, layer, kind, label, note_id, created_at, updated_at)
		 VALUES (?, 'structural', 'note', ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
		[id, title ?? noteId, noteId, now, now],
	);
}

export async function upsertTagNode(
	db: any,
	tag: JoplinTag,
): Promise<string> {
	const id = tagNodeId(tag.id);
	const now = new Date().toISOString();
	await run(
		db,
		`INSERT INTO nodes (id, layer, kind, label, created_at, updated_at)
		 VALUES (?, 'structural', 'entity', ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
		[id, tag.title, now, now],
	);
	return id;
}

export async function deleteStructuralEdgesForSource(db: any, sourceNodeId: string): Promise<void> {
	await run(db, `DELETE FROM edges WHERE source_id = ? AND layer = 'structural'`, [sourceNodeId]);
	// Also delete backlink edges where target is this source? Backlinks are materialized reverse, so delete where source is target's backlink? Simpler: delete backlinks where target_id = sourceNodeId and type='backlink'
	await run(db, `DELETE FROM edges WHERE target_id = ? AND layer = 'structural' AND type = 'backlink'`, [sourceNodeId]);
}

async function buildTitleIndex(noteIds?: string[]): Promise<Map<string, { id: string; created_time?: number }[]>> {
	// Build index from notes table (snapshot) for resolution. Falls back to empty if no notes.
	const db = getDatabase();
	const rows = await all<{ id: string; title: string; created_at: string | null }>(
		db,
		`SELECT id, title, created_at FROM notes`,
		[],
	);
	const map = new Map<string, { id: string; created_time?: number }[]>();
	for (const row of rows) {
		const key = (row.title ?? '').toLocaleLowerCase().trim();
		if (!key) continue;
		const list = map.get(key) ?? [];
		list.push({ id: row.id, created_time: row.created_at ? Date.parse(row.created_at) : undefined });
		map.set(key, list);
	}
	// Sort each bucket by earliest created_time
	for (const [key, list] of map) {
		list.sort((a, b) => (a.created_time ?? Number.MAX_SAFE_INTEGER) - (b.created_time ?? Number.MAX_SAFE_INTEGER));
		map.set(key, list);
	}
	return map;
}

export function resolveWikiLinkTarget(
	targetTitle: string,
	titleIndex: Map<string, { id: string; created_time?: number }[]>,
): string | null {
	const key = targetTitle.toLocaleLowerCase().trim();
	const candidates = titleIndex.get(key);
	if (!candidates || candidates.length === 0) return null;
	return candidates[0].id;
}

export async function writeStructuralGraphForNote(
	db: any,
	note: { id: string; title: string; body: string },
	tags: JoplinTag[],
	options: { titleIndex?: Map<string, { id: string; created_time?: number }[]> } = {},
): Promise<GraphWriteResult> {
	const sourceNodeId = noteNodeId(note.id);
	let nodesUpserted = 0;
	let edgesCreated = 0;

	await upsertNoteNode(db, note.id, note.title);
	nodesUpserted++;

	await deleteStructuralEdgesForSource(db, sourceNodeId);

	const titleIndex = options.titleIndex ?? (await buildTitleIndex());
	const links = extractWikiLinks(note.body ?? '');
	let unresolved = 0;
	const now = new Date().toISOString();

	// Wiki-link edges
	for (const link of links) {
		const targetNoteId = resolveWikiLinkTarget(link.target, titleIndex);
		if (!targetNoteId) {
			unresolved++;
			continue;
		}
		// Ensure target node exists (might not have been indexed yet)
		await upsertNoteNode(db, targetNoteId, link.target);
		const targetNodeId = noteNodeId(targetNoteId);

		const edgeIdStr = edgeId(sourceNodeId, targetNodeId, 'link');
		await run(
			db,
			`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at)
			 VALUES (?, 'structural', ?, ?, 'link', 1.0, ?)`,
			[edgeIdStr, sourceNodeId, targetNodeId, now],
		);
		edgesCreated++;

		// Backlink edge (reverse)
		const backlinkId = edgeId(targetNodeId, sourceNodeId, 'backlink');
		await run(
			db,
			`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at)
			 VALUES (?, 'structural', ?, ?, 'backlink', 1.0, ?)`,
			[backlinkId, targetNodeId, sourceNodeId, now],
		);
		edgesCreated++;
	}

	// Tag edges
	for (const tag of tags) {
		const tagNodeIdStr = await upsertTagNode(db, tag);
		nodesUpserted++;
		const eId = edgeId(sourceNodeId, tagNodeIdStr, 'tag');
		await run(
			db,
			`INSERT OR IGNORE INTO edges (id, layer, source_id, target_id, type, weight, created_at)
			 VALUES (?, 'structural', ?, ?, 'tag', 1.0, ?)`,
			[eId, sourceNodeId, tagNodeIdStr, now],
		);
		edgesCreated++;
	}

	return { nodesUpserted, edgesCreated, unresolvedLinks: unresolved };
}

export async function purgeGraphForNote(db: any, noteId: string): Promise<void> {
	const nodeId = noteNodeId(noteId);
	await run(db, `DELETE FROM edges WHERE source_id = ? OR target_id = ?`, [nodeId, nodeId]);
	await run(db, `DELETE FROM nodes WHERE id = ?`, [nodeId]);
}
