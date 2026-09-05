import type { Hit, RetrieverId, Reranker, RetrievalSettings } from './types';

export function reciprocalRankFusion(
	results: Map<RetrieverId, Hit[]>,
	settings: RetrievalSettings,
): Hit[] {
	const { rrfK, enabledRetrievers } = settings;

	const scores = new Map<string, { hit: Hit; score: number }>();

	for (const [retrieverId, hits] of results) {
		if (!enabledRetrievers[retrieverId]) continue;
		for (let i = 0; i < hits.length; i++) {
			const hit = hits[i];
			const key = hit.chunkId ?? `note:${hit.noteId}`;
			const rrfScore = 1 / (rrfK + i + 1);
			const existing = scores.get(key);
			if (existing) {
				existing.score += rrfScore;
			} else {
				scores.set(key, { hit: { ...hit }, score: rrfScore });
			}
		}
	}

	const fused = Array.from(scores.values())
		.sort((a, b) => b.score - a.score)
		.map((s) => ({ ...s.hit, score: s.score }));

	return fused;
}

export const identityReranker: Reranker = {
	async rerank(hits: Hit[], _query: string): Promise<Hit[]> {
		return hits;
	},
};

export async function applyRerank(
	hits: Hit[],
	query: string,
	reranker: Reranker,
): Promise<Hit[]> {
	try {
		return await reranker.rerank(hits, query);
	} catch {
		return hits;
	}
}