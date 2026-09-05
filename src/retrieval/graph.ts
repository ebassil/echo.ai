import type { Hit, RetrieveOptions, RetrieveContext } from './types';

export async function retrieveGraph(query: string, options: RetrieveOptions, context: RetrieveContext): Promise<Hit[]> {
	const { db } = context;
	const limit = options.limit ?? 50;
	const layer = options.graphLayer ?? 'both';

	const layerFilter = layer === 'both'
		? "layer IN ('structural','semantic')"
		: `layer = '${layer}'`;

	const searchTerms = query.trim().split(/\s+/).filter(Boolean);
	if (searchTerms.length === 0) return [];

	const placeholders = searchTerms.map(() => '?').join(' OR ');

	const sql = `
		WITH matched_nodes AS (
			SELECT DISTINCT n.id, n.note_id, n.label
			FROM nodes n
			WHERE ${layerFilter} AND (${placeholders.replace(/\?/g, 'n.label LIKE ?')})
			LIMIT 50
		),
		expanded AS (
			SELECT
				m.note_id AS source_note_id,
				e.source_id,
				e.target_id,
				e.weight,
				1 AS hops
			FROM matched_nodes m
			JOIN edges e ON e.source_id = m.id
			WHERE ${layerFilter}
			UNION
			SELECT
				m.note_id AS source_note_id,
				e.source_id,
				e.target_id,
				e.weight,
				1 AS hops
			FROM matched_nodes m
			JOIN edges e ON e.target_id = m.id
			WHERE ${layerFilter}
		),
		notes AS (
			SELECT DISTINCT n.id AS noteId, n.title, e.weight, e.hops
			FROM expanded e
			JOIN nodes n ON n.id = e.target_id AND n.kind = 'note'
		),
		chunks AS (
			SELECT c.id AS chunkId, n.noteId, n.title, c.content, n.weight, n.hops
			FROM notes n
			JOIN chunks c ON c.note_id = n.noteId
		)
		SELECT chunkId, noteId, title, content, weight, hops
		FROM chunks
		ORDER BY weight DESC, hops ASC
		LIMIT ?
	`;

	const params = searchTerms.flatMap((t) => [`%${t}%`]);
	params.push(String(limit));

	const rows: any[] = await new Promise((resolve, reject) => {
		db.all(sql, params, (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	return rows.map((row) => ({
		chunkId: row.chunkId,
		noteId: row.noteId,
		title: row.title,
		content: row.content,
		score: row.weight / (row.hops + 1),
	}));
}