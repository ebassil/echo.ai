import type { Hit, RetrieveOptions, RetrieveContext } from './types';

interface TFIDFCache {
	df: Map<string, number>;
	docCount: number;
	chunkCount: number;
	chunkIds: string[];
}

let tfidfCache: TFIDFCache | null = null;

const STOP_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
	'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

async function buildTFIDFCache(db: any): Promise<TFIDFCache> {
	const rows: { id: string; content: string }[] = await new Promise((resolve, reject) => {
		db.all('SELECT id, content FROM chunks', [], (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	const df = new Map<string, number>();
	const chunkIds: string[] = [];

	for (const row of rows) {
		const tokens = new Set(tokenize(row.content));
		for (const token of tokens) {
			df.set(token, (df.get(token) ?? 0) + 1);
		}
		chunkIds.push(row.id);
	}

	return {
		df,
		docCount: rows.length,
		chunkCount: rows.length,
		chunkIds,
	};
}

function getTFIDFCache(db: any): Promise<TFIDFCache> {
	if (tfidfCache && tfidfCache.chunkCount === tfidfCache.chunkIds.length) {
		return Promise.resolve(tfidfCache);
	}
	return buildTFIDFCache(db);
}

function computeTFIDFVector(tokens: string[], cache: TFIDFCache): Map<string, number> {
	const tf = new Map<string, number>();
	for (const token of tokens) {
		tf.set(token, (tf.get(token) ?? 0) + 1);
	}

	const tfidf = new Map<string, number>();
	const totalTokens = tokens.length;
	for (const [token, count] of tf) {
		const tfVal = count / totalTokens;
		const df = cache.df.get(token) ?? 1;
		const idf = Math.log((cache.docCount + 1) / (df + 1)) + 1;
		tfidf.set(token, tfVal * idf);
	}

	return tfidf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (const [token, val] of a) {
		dot += val * (b.get(token) ?? 0);
		normA += val * val;
	}
	for (const val of b.values()) {
		normB += val * val;
	}

	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieveTFIDF(query: string, options: RetrieveOptions, context: RetrieveContext): Promise<Hit[]> {
	const { db } = context;
	const limit = options.limit ?? 50;
	const candidateCutoff = Math.min(limit * 5, 200);

	const cache = await getTFIDFCache(db);
	if (cache.docCount === 0) return [];

	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];

	const queryVector = computeTFIDFVector(queryTokens, cache);

	const scores: Array<{ chunkId: string; score: number }> = [];

	const rows: { id: string; content: string; note_id: string }[] = await new Promise((resolve, reject) => {
		db.all('SELECT id, content, note_id FROM chunks LIMIT ?', [candidateCutoff], (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	for (const row of rows) {
		const tokens = tokenize(row.content);
		if (tokens.length === 0) continue;
		const docVector = computeTFIDFVector(tokens, cache);
		const score = cosineSimilarity(queryVector, docVector);
		if (score > 0) {
			scores.push({ chunkId: row.id, score });
		}
	}

	scores.sort((a, b) => b.score - a.score);
	const topScores = scores.slice(0, limit);

	if (topScores.length === 0) return [];

	const placeholders = topScores.map(() => '?').join(',');
	const chunkIds = topScores.map((s) => s.chunkId);
	const sql = `
		SELECT c.id AS chunkId, c.note_id AS noteId, n.title, c.content
		FROM chunks c
		JOIN notes n ON n.id = c.note_id
		WHERE c.id IN (${placeholders})
	`;

	const hits: any[] = await new Promise((resolve, reject) => {
		db.all(sql, chunkIds, (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	const hitMap = new Map(hits.map((h) => [h.chunkId, h]));
	const merged: Array<{ row: any; score: number }> = [];
	for (const s of topScores) {
		const row = hitMap.get(s.chunkId);
		if (row) merged.push({ row, score: s.score });
	}
	return merged.map(({ row, score }) => ({
		chunkId: row.chunkId,
		noteId: row.noteId,
		title: row.title,
		content: row.content,
		score,
	}));
}

export function invalidateTFIDFCache(): void {
	tfidfCache = null;
}