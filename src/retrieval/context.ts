import type { Hit, ChatContext, SearchResult, RetrievalSettings, RetrieveOptions } from './types';

const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_MAX_CHUNKS_PER_NOTE = 3;

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function getTokenCount(hit: Hit): number {
	return hit.content ? estimateTokens(hit.content) : 0;
}

export function assembleContext(
	hits: Hit[],
	settings: RetrievalSettings,
	options: RetrieveOptions = {},
): { chatContext: ChatContext; searchResults: SearchResult[] } {
	const tokenBudget = options.tokenBudget ?? settings.tokenBudget;
	const maxChunksPerNote = options.perNoteLimit ?? settings.maxChunksPerNote;

	const deduped = deduplicateHits(hits);
	const grouped = groupByNote(deduped, maxChunksPerNote);
	const truncated = truncateByTokenBudget(grouped, tokenBudget);

	const chatContext = buildChatContext(truncated);
	const searchResults = buildSearchResults(truncated);

	return { chatContext, searchResults };
}

function deduplicateHits(hits: Hit[]): Hit[] {
	const seen = new Map<string, Hit>();

	for (const hit of hits) {
		const key = hit.chunkId ?? `note:${hit.noteId}`;
		const existing = seen.get(key);
		if (!existing || hit.score > existing.score) {
			seen.set(key, hit);
		}
	}

	return Array.from(seen.values());
}

function groupByNote(hits: Hit[], maxChunksPerNote: number): Hit[] {
	const noteGroups = new Map<string, Hit[]>();

	for (const hit of hits) {
		const group = noteGroups.get(hit.noteId) ?? [];
		group.push(hit);
		noteGroups.set(hit.noteId, group);
	}

	const result: Hit[] = [];
	for (const [, group] of noteGroups) {
		const sorted = group.sort((a, b) => b.score - a.score);
		result.push(...sorted.slice(0, maxChunksPerNote));
	}

	return result.sort((a, b) => b.score - a.score);
}

function truncateByTokenBudget(hits: Hit[], tokenBudget: number): Hit[] {
	let totalTokens = 0;
	const result: Hit[] = [];

	for (const hit of hits) {
		const tokens = getTokenCount(hit);
		if (totalTokens + tokens > tokenBudget && totalTokens > 0) {
			break;
		}
		result.push(hit);
		totalTokens += tokens;
	}

	return result;
}

export function buildChatContext(hits: Hit[]): ChatContext {
	const chunks = hits.map((hit) => ({
		chunkId: hit.chunkId ?? '',
		noteId: hit.noteId,
		title: hit.title,
		content: hit.content,
		score: hit.score,
		contributingRetrievers: [] as any[],
	}));

	const totalTokens = chunks.reduce((sum, c) => sum + estimateTokens(c.content), 0);

	return { chunks, totalTokens };
}

export function buildSearchResults(hits: Hit[]): SearchResult[] {
	return hits.map((hit) => ({
		noteId: hit.noteId,
		title: hit.title,
		chunkText: hit.content,
		score: hit.score,
		contributingRetrievers: [] as any[],
	}));
}