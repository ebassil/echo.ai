import type { LLMProvider } from '../llm/provider';
import { errorMessage } from '../util/errors';

export interface EmbedderOptions {
	batchSize?: number;
	modelName?: string;
}

export interface EmbeddingResult {
	vectors: number[][];
	model: string;
	dims: number;
}

export const DEFAULT_EMBED_BATCH_SIZE = 32;

function float32ToBlob(vector: number[]): Buffer {
	const floatArray = new Float32Array(vector);
	return Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
}

export function serializeVector(vector: number[]): Buffer {
	return float32ToBlob(vector);
}

export function deserializeVector(blob: Buffer): number[] {
	const floatArray = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
	return Array.from(floatArray);
}

export async function embedChunks(
	provider: LLMProvider,
	texts: string[],
	options: EmbedderOptions = {},
): Promise<EmbeddingResult> {
	if (texts.length === 0) {
		return { vectors: [], model: options.modelName ?? 'unknown', dims: 0 };
	}
	const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE;
	const allVectors: number[][] = [];

	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		try {
			const vectors = await provider.embeddings(batch);
			if (vectors.length !== batch.length) {
				throw new Error(`Provider returned ${vectors.length} vectors for ${batch.length} texts`);
			}
			allVectors.push(...vectors);
		} catch (error) {
			throw new Error(`Embedding batch ${Math.floor(i / batchSize) + 1} failed: ${errorMessage(error)}`);
		}
	}

	const dims = allVectors.length > 0 ? allVectors[0].length : 0;
	// Try to infer model from provider if available; otherwise use options or unknown
	const model = options.modelName ?? (provider as any).model ?? 'unknown';

	return { vectors: allVectors, model, dims };
}

export async function shouldInvalidateEmbeddings(
	db: any,
	expectedModel: string,
): Promise<boolean> {
	try {
		const rows: { model: string }[] = await new Promise((resolve, reject) => {
			db.all('SELECT DISTINCT model FROM embeddings LIMIT 2', [], (err: Error | null, rows: any) => {
				if (err) reject(err);
				else resolve(rows);
			});
		});
		if (rows.length === 0) return false;
		return rows.some((r) => r.model !== expectedModel);
	} catch {
		return false;
	}
}
