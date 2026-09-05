import type { Hit, Reranker } from './types';

export const defaultReranker: Reranker = {
	async rerank(hits: Hit[], _query: string): Promise<Hit[]> {
		return hits;
	},
};