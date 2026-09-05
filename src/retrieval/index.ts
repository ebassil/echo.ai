import type { LLMProvider } from '../llm/provider';
import type {
	Hit,
	RetrieveOptions,
	RetrieveContext,
	RetrievalSettings,
	ChatContext,
	SearchResult,
	RetrieverId,
} from './types';
import { retrieveBM25 } from './bm25';
import { retrieveTFIDF, invalidateTFIDFCache } from './tfidf';
import { retrieveFuzzy } from './fuzzy';
import { retrieveDense } from './dense';
import { retrieveGraph } from './graph';
import { reciprocalRankFusion, applyRerank, identityReranker } from './fusion';
import { assembleContext } from './context';
import { loadRetrievalSettings } from './settings';
import { getProvider } from '../plugin/runtime';

const RETRIEVERS: RetrieverId[] = ['bm25', 'tfidf', 'fuzzy', 'dense', 'graph'];

let settingsCache: RetrievalSettings | null = null;

export async function getRetrievalContext(): Promise<RetrieveContext> {
	const { getDatabase } = await import('../storage/db');
	const settings = await loadRetrievalSettings();

	return {
		db: getDatabase(),
		provider: getProvider(),
		settings,
	};
}

async function runRetriever(
	id: RetrieverId,
	query: string,
	options: RetrieveOptions,
	context: RetrieveContext,
): Promise<Hit[]> {
	switch (id) {
		case 'bm25':
			return retrieveBM25(query, options, context);
		case 'tfidf':
			return retrieveTFIDF(query, options, context);
		case 'fuzzy':
			return retrieveFuzzy(query, options, context);
		case 'dense':
			return retrieveDense(query, options, context);
		case 'graph':
			return retrieveGraph(query, options, context);
		default:
			return [];
	}
}

export async function retrieve(query: string, options: RetrieveOptions = {}): Promise<Hit[]> {
	if (!query.trim()) return [];

	const context = await getRetrievalContext();
	const settings = context.settings;

	const enabledRetrievers = options.retrievers?.filter((r) => settings.enabledRetrievers[r])
		?? RETRIEVERS.filter((r) => settings.enabledRetrievers[r]);

	const results = new Map<RetrieverId, Hit[]>();

	await Promise.all(
		enabledRetrievers.map(async (id) => {
			try {
				const hits = await runRetriever(id, query, options, context);
				results.set(id, hits);
			} catch (error) {
				console.error(`[retrieval] ${id} retriever failed:`, error);
				results.set(id, []);
			}
		}),
	);

	const fused = reciprocalRankFusion(results, settings);

	if (settings.rerankEnabled && settings.rerankModel) {
		const provider: LLMProvider = getProvider();
		if ((provider as any).name === 'ollama') {
			const { defaultReranker } = await import('./rerank');
			return applyRerank(fused, query, defaultReranker);
		}
		return applyRerank(fused, query, identityReranker);
	}

	return fused;
}

export function buildChatContext(hits: Hit[], options: RetrieveOptions = {}): ChatContext {
	const settings = settingsCache ?? {
		enabledRetrievers: { bm25: true, tfidf: true, fuzzy: true, dense: true, graph: true },
		denseK: 20,
		tokenBudget: 4000,
		maxChunksPerNote: 3,
		rrfK: 60,
		rerankEnabled: false,
		rerankModel: '',
	};
	return assembleContext(hits, settings, options).chatContext;
}

export function buildSearchResults(hits: Hit[], options: RetrieveOptions = {}): SearchResult[] {
	const settings = settingsCache ?? {
		enabledRetrievers: { bm25: true, tfidf: true, fuzzy: true, dense: true, graph: true },
		denseK: 20,
		tokenBudget: 4000,
		maxChunksPerNote: 3,
		rrfK: 60,
		rerankEnabled: false,
		rerankModel: '',
	};
	return assembleContext(hits, settings, options).searchResults;
}

export function invalidateCache(): void {
	invalidateTFIDFCache();
}