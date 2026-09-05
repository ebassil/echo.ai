import type { Hit, RetrieveOptions, RetrieveContext } from './types';

export async function retrieveFuzzy(query: string, options: RetrieveOptions, context: RetrieveContext): Promise<Hit[]> {
	const { db } = context;
	const limit = options.limit ?? 50;
	const candidateLimit = Math.min(limit * 3, 100);

	const sanitized = query.trim().replace(/"/g, '""');
	if (!sanitized) return [];

	try {
		const trigramHits = await tryTrigramFTS5(query, candidateLimit, db);
		if (trigramHits.length > 0) {
			return rankByEditDistance(trigramHits, query, limit);
		}
	} catch {
	}

	return fallbackTitleScan(query, candidateLimit, limit, db);
}

async function tryTrigramFTS5(query: string, limit: number, db: any): Promise<Hit[]> {
	const sanitized = query.trim().replace(/"/g, '""');
	if (!sanitized) return [];

	const sql = `
		SELECT
			c.id AS chunkId,
			c.note_id AS noteId,
			n.title,
			c.content
		FROM chunks_fts
		JOIN chunks c ON c.id = chunks_fts.rowid
		JOIN notes n ON n.id = c.note_id
		WHERE chunks_fts MATCH ?
		LIMIT ?
	`;

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
		content: row.content,
		score: 0,
	}));
}

function rankByEditDistance(hits: Hit[], query: string, limit: number): Hit[] {
	const normalizedQuery = normalizeForEditDistance(query);

	const scored = hits.map((hit) => {
		const normalizedTitle = normalizeForEditDistance(hit.title);
		const distance = damerauLevenshtein(normalizedTitle, normalizedQuery);
		return { ...hit, score: -distance };
	});

	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, limit);
}

async function fallbackTitleScan(query: string, candidateLimit: number, limit: number, db: any): Promise<Hit[]> {
	const normalizedQuery = normalizeForEditDistance(query);

	const sql = `
		SELECT
			c.id AS chunkId,
			c.note_id AS noteId,
			n.title,
			c.content
		FROM chunks c
		JOIN notes n ON n.id = c.note_id
		LIMIT ?
	`;

	const rows: any[] = await new Promise((resolve, reject) => {
		db.all(sql, [candidateLimit], (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	const scored = rows
		.map((row) => ({
			chunkId: row.chunkId,
			noteId: row.noteId,
			title: row.title,
			content: row.content,
			score: -damerauLevenshtein(normalizeForEditDistance(row.title), normalizedQuery),
		}))
		.filter((h) => h.score > -10);

	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, limit);
}

function normalizeForEditDistance(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function damerauLevenshtein(s1: string, s2: string): number {
	const len1 = s1.length;
	const len2 = s2.length;

	if (len1 === 0) return len2;
	if (len2 === 0) return len1;

	const INF = len1 + len2;
	const d: number[][] = Array(len1 + 2)
		.fill(null)
		.map(() => Array(len2 + 2).fill(0));

	d[0][0] = INF;
	for (let i = 0; i <= len1; i++) {
		d[i + 1][1] = i;
		d[i + 1][0] = INF;
	}
	for (let j = 0; j <= len2; j++) {
		d[1][j + 1] = j;
		d[0][j + 1] = INF;
	}

	const da = new Map<string, number>();

	for (let i = 1; i <= len1; i++) {
		let db = 0;
		for (let j = 1; j <= len2; j++) {
			const i1 = da.get(s2[j - 1]) ?? 0;
			const j1 = db;
			const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;

			if (cost === 0) db = j;

			d[i + 1][j + 1] = Math.min(
				d[i][j] + cost,
				d[i + 1][j] + 1,
				d[i][j + 1] + 1,
				d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1),
			);
		}
		da.set(s1[i - 1], i);
	}

	return d[len1 + 1][len2 + 1];
}