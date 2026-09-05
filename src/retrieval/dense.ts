import type { Hit, RetrieveOptions, RetrieveContext } from './types';

export async function retrieveDense(query: string, options: RetrieveOptions, context: RetrieveContext): Promise<Hit[]> {
	const { db, provider, settings } = context;
	const k = options.limit ?? settings.denseK;

	if (!provider?.embeddings) {
		return [];
	}

	const dimCheckRows: { dims: number }[] = await new Promise((resolve, reject) => {
		db.all('SELECT dims FROM embeddings LIMIT 1', [], (err: Error | null, rows: any[]) => {
			if (err) reject(err);
			else resolve(rows);
		});
	});

	if (dimCheckRows.length === 0) {
		return [];
	}

	const expectedDims = dimCheckRows[0].dims;

	let queryEmbedding: number[];
	try {
		const vectors = await provider.embeddings([query]);
		if (vectors.length === 0 || vectors[0].length !== expectedDims) {
			return [];
		}
		queryEmbedding = vectors[0];
	} catch {
		return [];
	}

	const rows: { chunk_id: string; vector: Buffer; note_id: string; title: string; content: string }[] = await new Promise((resolve, reject) => {
		db.all(
			`SELECT e.chunk_id, e.vector, c.note_id, n.title, c.content
			 FROM embeddings e
			 JOIN chunks c ON c.id = e.chunk_id
			 JOIN notes n ON n.id = c.note_id
			 WHERE e.dims = ?`,
			[expectedDims],
			(err: Error | null, rows: any[]) => {
				if (err) reject(err);
				else resolve(rows);
			},
		);
	});

	if (rows.length === 0) {
		return [];
	}

	const scored = rows.map((row) => {
		const storedVector = deserializeVector(row.vector);
		const similarity = cosineSimilarity(queryEmbedding, storedVector);
		return {
			chunkId: row.chunk_id,
			noteId: row.note_id,
			title: row.title,
			content: row.content,
			score: similarity,
		};
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k);
}

function deserializeVector(buffer: Buffer): number[] {
	const floatArray = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
	return Array.from(floatArray);
}

function cosineSimilarity(a: number[], b: number[]): number {
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