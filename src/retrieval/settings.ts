import joplin from 'api';
import { SettingItemType } from 'api/types';
import type { RetrievalSettings, RetrieverId } from './types';

export const RETRIEVAL_SETTINGS = {
	enabledRetrievers: 'echo.retrievalRetrievers',
	denseK: 'echo.retrievalDenseK',
	tokenBudget: 'echo.retrievalTokenBudget',
	maxChunksPerNote: 'echo.retrievalMaxChunksPerNote',
	rrfK: 'echo.retrievalRrfK',
	rerankEnabled: 'echo.retrievalRerankEnabled',
	rerankModel: 'echo.retrievalRerankModel',
} as const;

const DEFAULT_ENABLED: Record<RetrieverId, boolean> = {
	bm25: true,
	tfidf: true,
	fuzzy: true,
	dense: true,
	graph: true,
};

export const DEFAULT_RETRIEVAL_SETTINGS: RetrievalSettings = {
	enabledRetrievers: DEFAULT_ENABLED,
	denseK: 20,
	tokenBudget: 4000,
	maxChunksPerNote: 3,
	rrfK: 60,
	rerankEnabled: false,
	rerankModel: '',
};

const RETRIEVER_OPTIONS: Record<RetrieverId, string> = {
	bm25: 'BM25 (FTS5)',
	tfidf: 'TF-IDF',
	fuzzy: 'Fuzzy (trigram/edit-distance)',
	dense: 'Dense (embedding kNN)',
	graph: 'Graph (entity + neighborhood)',
};

export async function registerRetrievalSettings(): Promise<void> {
	await joplin.settings.registerSettings({
		[RETRIEVAL_SETTINGS.enabledRetrievers]: {
			value: JSON.stringify(DEFAULT_ENABLED),
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			label: 'Enabled retrievers',
			description: 'JSON object mapping retriever IDs to boolean enabled state. Example: {"bm25":true,"tfidf":true,"fuzzy":true,"dense":true,"graph":true}',
		},
		[RETRIEVAL_SETTINGS.denseK]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.denseK,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Dense retriever k',
			description: 'Number of nearest neighbors to retrieve from the embedding index.',
			minimum: 1,
			maximum: 100,
			step: 1,
		},
		[RETRIEVAL_SETTINGS.tokenBudget]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.tokenBudget,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Token budget',
			description: 'Maximum tokens for assembled context (chat prompt). Approximate; uses chunk token_count where available.',
			minimum: 500,
			maximum: 32000,
			step: 100,
		},
		[RETRIEVAL_SETTINGS.maxChunksPerNote]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.maxChunksPerNote,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Max chunks per note',
			description: 'Maximum chunks contributed by a single note in assembled context.',
			minimum: 1,
			maximum: 20,
			step: 1,
		},
		[RETRIEVAL_SETTINGS.rrfK]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.rrfK,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'RRF k parameter',
			description: 'Reciprocal rank fusion parameter k (1/(k + rank)). Default 60.',
			minimum: 1,
			maximum: 200,
			step: 1,
		},
		[RETRIEVAL_SETTINGS.rerankEnabled]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.rerankEnabled,
			type: SettingItemType.Bool,
			public: true,
			section: 'echo',
			label: 'Enable reranking',
			description: 'Apply optional reranker to fused top results.',
		},
		[RETRIEVAL_SETTINGS.rerankModel]: {
			value: DEFAULT_RETRIEVAL_SETTINGS.rerankModel,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			label: 'Rerank model',
			description: 'Model identifier for reranker (provider-specific).',
		},
	});
}

export async function loadRetrievalSettings(): Promise<RetrievalSettings> {
	const values = await joplin.settings.values([
		RETRIEVAL_SETTINGS.enabledRetrievers,
		RETRIEVAL_SETTINGS.denseK,
		RETRIEVAL_SETTINGS.tokenBudget,
		RETRIEVAL_SETTINGS.maxChunksPerNote,
		RETRIEVAL_SETTINGS.rrfK,
		RETRIEVAL_SETTINGS.rerankEnabled,
		RETRIEVAL_SETTINGS.rerankModel,
	]);

	let enabledRetrievers = DEFAULT_ENABLED;
	try {
		const raw = values[RETRIEVAL_SETTINGS.enabledRetrievers];
		if (typeof raw === 'string') {
			const parsed = JSON.parse(raw);
			enabledRetrievers = { ...DEFAULT_ENABLED, ...parsed };
		}
	} catch {
		enabledRetrievers = DEFAULT_ENABLED;
	}

	const denseK = toInt(values[RETRIEVAL_SETTINGS.denseK], DEFAULT_RETRIEVAL_SETTINGS.denseK);
	const tokenBudget = toInt(values[RETRIEVAL_SETTINGS.tokenBudget], DEFAULT_RETRIEVAL_SETTINGS.tokenBudget);
	const maxChunksPerNote = toInt(values[RETRIEVAL_SETTINGS.maxChunksPerNote], DEFAULT_RETRIEVAL_SETTINGS.maxChunksPerNote);
	const rrfK = toInt(values[RETRIEVAL_SETTINGS.rrfK], DEFAULT_RETRIEVAL_SETTINGS.rrfK);
	const rerankEnabled = values[RETRIEVAL_SETTINGS.rerankEnabled] === true;
	const rerankModel = typeof values[RETRIEVAL_SETTINGS.rerankModel] === 'string' ? values[RETRIEVAL_SETTINGS.rerankModel] : '';

	return {
		enabledRetrievers,
		denseK: clamp(denseK, 1, 100),
		tokenBudget: clamp(tokenBudget, 500, 32000),
		maxChunksPerNote: clamp(maxChunksPerNote, 1, 20),
		rrfK: clamp(rrfK, 1, 200),
		rerankEnabled,
		rerankModel,
	};
}

export function validateRetrievalSettings(settings: RetrievalSettings): string[] {
	const errors: string[] = [];

	if (!settings.enabledRetrievers || typeof settings.enabledRetrievers !== 'object') {
		errors.push('Enabled retrievers must be an object mapping retriever IDs to booleans.');
	}

	if (!Number.isInteger(settings.denseK) || settings.denseK < 1 || settings.denseK > 100) {
		errors.push('Dense k must be an integer between 1 and 100.');
	}

	if (!Number.isInteger(settings.tokenBudget) || settings.tokenBudget < 500 || settings.tokenBudget > 32000) {
		errors.push('Token budget must be an integer between 500 and 32000.');
	}

	if (!Number.isInteger(settings.maxChunksPerNote) || settings.maxChunksPerNote < 1 || settings.maxChunksPerNote > 20) {
		errors.push('Max chunks per note must be an integer between 1 and 20.');
	}

	if (!Number.isInteger(settings.rrfK) || settings.rrfK < 1 || settings.rrfK > 200) {
		errors.push('RRF k must be an integer between 1 and 200.');
	}

	if (typeof settings.rerankEnabled !== 'boolean') {
		errors.push('Rerank enabled must be a boolean.');
	}

	return errors;
}

function toInt(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
	if (typeof value === 'string') {
		const parsed = parseInt(value, 10);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}