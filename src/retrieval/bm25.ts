import type { Hit, RetrieveOptions, RetrieveContext } from './types';

export async function retrieveBM25(query: string, options: RetrieveOptions, context: RetrieveContext): Promise<Hit[]> {
	const { db } = context;
	const limit = options.limit ?? 50;

	const sanitized = sanitizeFTS5Query(query);
	const sql = `
		SELECT
			c.id AS chunkId,
			c.note_id AS noteId,
			n.title,
			c.content,
			bm25(chunks_fts) AS score,
			snippet(chunks_fts, '<mark>', '</mark>', '...', 20) AS snippet
		FROM chunks_fts
		JOIN chunks c ON c.id = chunks_fts.rowid
		JOIN notes n ON n.id = c.note_id
		WHERE chunks_fts MATCH ?
		ORDER BY bm25(chunks_fts)
		LIMIT ?
	`;

	try {
		const rows: any[] = await new Promise((resolve, reject) => {
			db.all(sql, [sanitized, limit], (err: Error | null, rows: any[]) => {
				if (err) reject(err);
				else resolve(rows);
			});
		});

		return rows.map((row) => ({
			chunkId: row.chunkId,
			noteId: row.noteId,
			title: row.title,
			content: row.snippet ?? row.content,
			score: row.score,
		}));
	} catch (error) {
		const err = error as Error;
		if (err.message?.includes('syntax error') || err.message?.includes('near')) {
			const fallback = sanitizeFTS5Query(query, true);
			return retrieveBM25Fallback(fallback, limit, db);
		}
		throw error;
	}
}

async function retrieveBM25Fallback(query: string, limit: number, db: any): Promise<Hit[]> {
	const sql = `
		SELECT
			c.id AS chunkId,
			c.note_id AS noteId,
			n.title,
			c.content,
			0 AS score
		FROM chunks c
		JOIN notes n ON n.id = c.note_id
		WHERE n.title LIKE ? OR c.content LIKE ?
		LIMIT ?
	`;
	const param = `%${query}%`;

	const rows: any[] = await new Promise((resolve, reject) => {
		db.all(sql, [param, param, limit], (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	return rows.map((row) => ({
		chunkId: row.chunkId,
		noteId: row.noteId,
		title: row.title,
		content: row.content,
		score: 0,
	}));
}

export function sanitizeFTS5Query(query: string, phraseOnly = false): string {
	if (!query.trim()) return '""';

	const terms = query
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	if (terms.length === 0) return '""';

	if (phraseOnly) {
		return `"${query.replace(/"/g, '""')}"`;
	}

	const sanitized = terms
		.map((term) => term.replace(/"/g, '""'))
		.map((term) => (term.includes(' ') ? `"${term}"` : term))
		.join(' AND ');

	return sanitized || '""';
}