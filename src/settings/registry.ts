import joplin from 'api';
import { SettingItemType } from 'api/types';

export const SETTINGS = {
	provider: 'echo.provider',
	baseUrl: 'echo.baseUrl',
	model: 'echo.model',
	connectionTimeoutSeconds: 'echo.connectionTimeoutSeconds',
	chunkSize: 'echo.chunkSize',
	chunkOverlap: 'echo.chunkOverlap',
	embeddingBatchSize: 'echo.embeddingBatchSize',
	canonicalizationMode: 'echo.canonicalizationMode',
	canonicalSimilarity: 'echo.canonicalSimilarity',
	extractionGranularity: 'echo.extractionGranularity',
	extractionConcurrency: 'echo.extractionConcurrency',
	extractionMaxChars: 'echo.extractionMaxChars',
	extractionModel: 'echo.extractionModel',
	semanticCascade: 'echo.semanticCascade',
	semanticCascadeDepth: 'echo.semanticCascadeDepth',
	semanticCascadeFanoutCap: 'echo.semanticCascadeFanoutCap',
	enrichmentEnabled: 'echo.enrichmentEnabled',
} as const;

export const DEFAULT_SETTINGS: EchoSettings = {
	provider: 'ollama',
	baseUrl: 'http://localhost:11434',
	model: 'llama3',
	connectionTimeoutSeconds: 15,
	chunkSize: 2000,
	chunkOverlap: 200,
	embeddingBatchSize: 32,
	canonicalizationMode: 'exact',
	canonicalSimilarity: 0.85,
	extractionGranularity: 'per-note',
	extractionConcurrency: 1,
	extractionMaxChars: 8000,
	extractionModel: '',
	semanticCascade: 'lazy',
	semanticCascadeDepth: 1,
	semanticCascadeFanoutCap: 50,
	enrichmentEnabled: false,
};

const PROVIDER_OPTIONS: Record<string, string> = {
	ollama: 'Ollama (local)',
};

export interface EchoSettings {
	provider: string;
	baseUrl: string;
	model: string;
	connectionTimeoutSeconds: number;
	chunkSize: number;
	chunkOverlap: number;
	embeddingBatchSize: number;
	canonicalizationMode: 'exact' | 'embedding';
	canonicalSimilarity: number;
	extractionGranularity: 'per-note' | 'per-chunk' | 'per-note+per-chunk';
	extractionConcurrency: number;
	extractionMaxChars: number;
	extractionModel: string;
	semanticCascade: 'lazy' | 'eager';
	semanticCascadeDepth: number;
	semanticCascadeFanoutCap: number;
	enrichmentEnabled: boolean;
}

export interface SettingsResolution {
	settings: EchoSettings;
	errors: string[];
}

export async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection('echo', {
		label: 'echo.ai',
		iconName: 'fas fa-robot',
		description: 'Settings for the echo.ai plugin.',
	});

	await joplin.settings.registerSettings({
		[SETTINGS.provider]: {
			value: DEFAULT_SETTINGS.provider,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			isEnum: true,
			options: PROVIDER_OPTIONS,
			label: 'LLM provider',
			description: 'The LLM provider used for chat, embeddings, and extraction.',
		},
		[SETTINGS.baseUrl]: {
			value: DEFAULT_SETTINGS.baseUrl,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			label: 'Provider base URL',
			description: 'Base URL of the OpenAI-compatible /v1 endpoint, e.g. http://localhost:11434.',
		},
		[SETTINGS.model]: {
			value: DEFAULT_SETTINGS.model,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			label: 'Model name',
			description: 'Name of the model to use, e.g. llama3.',
		},
		[SETTINGS.connectionTimeoutSeconds]: {
			value: DEFAULT_SETTINGS.connectionTimeoutSeconds,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Connection test timeout (seconds)',
			description: 'Maximum time the connection test waits for the provider before giving up.',
			minimum: 1,
			maximum: 120,
			step: 1,
		},
		[SETTINGS.chunkSize]: {
			value: DEFAULT_SETTINGS.chunkSize,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Chunk size (chars)',
			description: 'Maximum characters per indexed chunk (heading-aware).',
			minimum: 500,
			maximum: 8000,
			step: 100,
		},
		[SETTINGS.chunkOverlap]: {
			value: DEFAULT_SETTINGS.chunkOverlap,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Chunk overlap (chars)',
			description: 'Overlap in characters between consecutive chunks.',
			minimum: 0,
			maximum: 1000,
			step: 10,
		},
		[SETTINGS.embeddingBatchSize]: {
			value: DEFAULT_SETTINGS.embeddingBatchSize,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Embedding batch size',
			description: 'Number of chunks per embedding request.',
			minimum: 1,
			maximum: 128,
			step: 1,
		},
		[SETTINGS.canonicalizationMode]: {
			value: DEFAULT_SETTINGS.canonicalizationMode,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			isEnum: true,
			options: { exact: 'Exact (case-fold)', embedding: 'Embedding' },
			label: 'Canonicalization mode',
			description: 'Entity deduplication mode: exact case-fold or embedding similarity.',
		},
		[SETTINGS.canonicalSimilarity]: {
			value: Math.round(DEFAULT_SETTINGS.canonicalSimilarity * 100),
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Canonical similarity (x100)',
			description: 'Cosine threshold for embedding merge (70-95, default 85 = 0.85).',
			minimum: 70,
			maximum: 95,
			step: 1,
		},
		[SETTINGS.extractionGranularity]: {
			value: DEFAULT_SETTINGS.extractionGranularity,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			isEnum: true,
			options: { 'per-note': 'Per-note', 'per-chunk': 'Per-chunk', 'per-note+per-chunk': 'Per-note + Per-chunk' },
			label: 'Extraction granularity',
			description: 'Controls whether extraction runs per-note, per-chunk, or both.',
		},
		[SETTINGS.extractionConcurrency]: {
			value: DEFAULT_SETTINGS.extractionConcurrency,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Extraction concurrency',
			description: 'Max parallel extraction calls (1-4, default 1).',
			minimum: 1,
			maximum: 4,
			step: 1,
		},
		[SETTINGS.extractionMaxChars]: {
			value: DEFAULT_SETTINGS.extractionMaxChars,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Extraction max chars',
			description: 'Per-note extraction window cap; longer notes use chunked fallback.',
			minimum: 1000,
			maximum: 20000,
			step: 100,
		},
		[SETTINGS.extractionModel]: {
			value: DEFAULT_SETTINGS.extractionModel,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			label: 'Extraction model (optional)',
			description: 'Model for extraction; falls back to Model name if empty.',
		},
		[SETTINGS.semanticCascade]: {
			value: DEFAULT_SETTINGS.semanticCascade,
			type: SettingItemType.String,
			public: true,
			section: 'echo',
			isEnum: true,
			options: { lazy: 'Lazy', eager: 'Eager' },
			label: 'Semantic cascade mode',
			description: 'Lazy (no neighbor re-extract) or eager (re-extract neighbors).',
		},
		[SETTINGS.semanticCascadeDepth]: {
			value: DEFAULT_SETTINGS.semanticCascadeDepth,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Cascade depth',
			description: 'Depth for eager cascade (1-5).',
			minimum: 1,
			maximum: 5,
			step: 1,
		},
		[SETTINGS.semanticCascadeFanoutCap]: {
			value: DEFAULT_SETTINGS.semanticCascadeFanoutCap,
			type: SettingItemType.Int,
			public: true,
			section: 'echo',
			label: 'Cascade fanout cap',
			description: 'Max neighbor notes per cascade level (10-200).',
			minimum: 10,
			maximum: 200,
			step: 10,
		},
		[SETTINGS.enrichmentEnabled]: {
			value: DEFAULT_SETTINGS.enrichmentEnabled,
			type: SettingItemType.Bool,
			public: true,
			section: 'echo',
			label: 'Enable structural enrichment',
			description: 'When enabled, writes suggested tags/wiki-links back to notes.',
		},
	});
}

export async function resolveSettings(): Promise<SettingsResolution> {
	const raw = await loadSettings();
	const errors = validateSettings(raw);

	// canonicalSimilarity is stored as int 70-95; convert to 0.70-0.95
	const rawSim = raw.canonicalSimilarity as any;
	let sim = typeof rawSim === 'number' ? rawSim / (rawSim > 1 ? 100 : 1) : DEFAULT_SETTINGS.canonicalSimilarity;
	if (rawSim !== undefined && typeof rawSim === 'number' && rawSim >= 70 && rawSim <= 95) sim = rawSim / 100;

	const settings: EchoSettings = {
		provider: isValidProvider(raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider,
		baseUrl: isValidBaseUrl(raw.baseUrl) ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
		model: isValidModel(raw.model) ? raw.model : DEFAULT_SETTINGS.model,
		connectionTimeoutSeconds: isValidTimeout(raw.connectionTimeoutSeconds)
			? raw.connectionTimeoutSeconds
			: DEFAULT_SETTINGS.connectionTimeoutSeconds,
		chunkSize: isValidChunkSize(raw.chunkSize) ? raw.chunkSize : DEFAULT_SETTINGS.chunkSize,
		chunkOverlap: isValidChunkOverlap(raw.chunkOverlap) ? raw.chunkOverlap : DEFAULT_SETTINGS.chunkOverlap,
		embeddingBatchSize: isValidBatchSize(raw.embeddingBatchSize) ? raw.embeddingBatchSize : DEFAULT_SETTINGS.embeddingBatchSize,
		canonicalizationMode: isValidCanonicalMode(raw.canonicalizationMode) ? raw.canonicalizationMode : DEFAULT_SETTINGS.canonicalizationMode,
		canonicalSimilarity: isValidCanonicalSimilarity(sim) ? sim : DEFAULT_SETTINGS.canonicalSimilarity,
		extractionGranularity: isValidGranularity(raw.extractionGranularity) ? raw.extractionGranularity : DEFAULT_SETTINGS.extractionGranularity,
		extractionConcurrency: isValidConcurrency(raw.extractionConcurrency) ? raw.extractionConcurrency : DEFAULT_SETTINGS.extractionConcurrency,
		extractionMaxChars: isValidMaxChars(raw.extractionMaxChars) ? raw.extractionMaxChars : DEFAULT_SETTINGS.extractionMaxChars,
		extractionModel: isValidExtractionModel(raw.extractionModel) ? raw.extractionModel : DEFAULT_SETTINGS.extractionModel,
		semanticCascade: isValidCascadeMode(raw.semanticCascade) ? raw.semanticCascade : DEFAULT_SETTINGS.semanticCascade,
		semanticCascadeDepth: isValidCascadeDepth(raw.semanticCascadeDepth) ? raw.semanticCascadeDepth : DEFAULT_SETTINGS.semanticCascadeDepth,
		semanticCascadeFanoutCap: isValidFanoutCap(raw.semanticCascadeFanoutCap) ? raw.semanticCascadeFanoutCap : DEFAULT_SETTINGS.semanticCascadeFanoutCap,
		enrichmentEnabled: typeof raw.enrichmentEnabled === 'boolean' ? raw.enrichmentEnabled : DEFAULT_SETTINGS.enrichmentEnabled,
	};

	return { settings, errors };
}

export function validateSettings(settings: EchoSettings): string[] {
	const errors: string[] = [];

	if (!isValidProvider(settings.provider)) {
		errors.push(`Unknown provider "${settings.provider}". Supported providers: ${Object.keys(PROVIDER_OPTIONS).join(', ')}.`);
	}

	if (!isValidBaseUrl(settings.baseUrl)) {
		errors.push(`Invalid base URL "${settings.baseUrl}". Expected an http(s) URL such as http://localhost:11434.`);
	}

	if (!isValidModel(settings.model)) {
		errors.push('Model name must not be empty.');
	}

	if (!isValidTimeout(settings.connectionTimeoutSeconds)) {
		errors.push('Connection test timeout must be between 1 and 120 seconds.');
	}

	if (!isValidChunkSize(settings.chunkSize)) {
		errors.push('Chunk size must be between 500 and 8000 characters.');
	}

	if (!isValidChunkOverlap(settings.chunkOverlap)) {
		errors.push('Chunk overlap must be between 0 and 1000 characters.');
	}

	if (!isValidBatchSize(settings.embeddingBatchSize)) {
		errors.push('Embedding batch size must be between 1 and 128.');
	}

	if (!isValidCanonicalMode(settings.canonicalizationMode)) {
		errors.push('Canonicalization mode must be exact or embedding.');
	}

	if (!isValidCanonicalSimilarity(settings.canonicalSimilarity)) {
		errors.push('Canonical similarity must be between 0.70 and 0.95.');
	}

	if (!isValidGranularity(settings.extractionGranularity)) {
		errors.push('Extraction granularity must be per-note, per-chunk, or per-note+per-chunk.');
	}

	if (!isValidConcurrency(settings.extractionConcurrency)) {
		errors.push('Extraction concurrency must be between 1 and 4.');
	}

	if (!isValidMaxChars(settings.extractionMaxChars)) {
		errors.push('Extraction max chars must be between 1000 and 20000.');
	}

	if (!isValidExtractionModel(settings.extractionModel)) {
		errors.push('Extraction model must be a string.');
	}

	if (!isValidCascadeMode(settings.semanticCascade)) {
		errors.push('Semantic cascade must be lazy or eager.');
	}

	if (!isValidCascadeDepth(settings.semanticCascadeDepth)) {
		errors.push('Semantic cascade depth must be between 1 and 5.');
	}

	if (!isValidFanoutCap(settings.semanticCascadeFanoutCap)) {
		errors.push('Semantic cascade fanout cap must be between 10 and 200.');
	}

	if (typeof settings.enrichmentEnabled !== 'boolean') {
		errors.push('Enrichment enabled must be boolean.');
	}

	return errors;
}

function isValidProvider(provider: string): boolean {
	return Object.prototype.hasOwnProperty.call(PROVIDER_OPTIONS, provider);
}

function isValidModel(model: string): boolean {
	return typeof model === 'string' && model.trim().length > 0;
}

function isValidTimeout(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 120;
}

function isValidChunkSize(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 500 && value <= 8000;
}

function isValidChunkOverlap(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
}

function isValidBatchSize(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 128;
}

function isValidCanonicalMode(value: string): boolean {
	return value === 'exact' || value === 'embedding';
}

function isValidCanonicalSimilarity(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0.7 && value <= 0.95;
}

function isValidGranularity(value: string): boolean {
	return value === 'per-note' || value === 'per-chunk' || value === 'per-note+per-chunk';
}

function isValidConcurrency(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 4;
}

function isValidMaxChars(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 20000;
}

function isValidExtractionModel(value: string): boolean {
	return typeof value === 'string';
}

function isValidCascadeMode(value: string): boolean {
	return value === 'lazy' || value === 'eager';
}

function isValidCascadeDepth(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5;
}

function isValidFanoutCap(value: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 200;
}

export async function watchSettings(): Promise<void> {
	await joplin.settings.onChange((event) => {
		const changedKeys = event.keys;
		const relevant = Object.values(SETTINGS).some((key) => changedKeys.includes(key));
		if (!relevant) return;

		void loadSettings().then((settings) => {
			const errors = validateSettings(settings);
			if (errors.length === 0) return;
			console.warn('[echo] invalid settings', errors);
			void joplin.views.dialogs.showMessageBox(
				`echo.ai settings are invalid and will not be used.\n\n${errors.map((error) => `- ${error}`).join('\n')}`,
			);
		});
	});
}

async function loadSettings(): Promise<EchoSettings> {
	const values = await joplin.settings.values([
		SETTINGS.provider,
		SETTINGS.baseUrl,
		SETTINGS.model,
		SETTINGS.connectionTimeoutSeconds,
		SETTINGS.chunkSize,
		SETTINGS.chunkOverlap,
		SETTINGS.embeddingBatchSize,
		SETTINGS.canonicalizationMode,
		SETTINGS.canonicalSimilarity,
		SETTINGS.extractionGranularity,
		SETTINGS.extractionConcurrency,
		SETTINGS.extractionMaxChars,
		SETTINGS.extractionModel,
		SETTINGS.semanticCascade,
		SETTINGS.semanticCascadeDepth,
		SETTINGS.semanticCascadeFanoutCap,
		SETTINGS.enrichmentEnabled,
	]);
	const timeout = values[SETTINGS.connectionTimeoutSeconds];
	const chunkSize = values[SETTINGS.chunkSize];
	const chunkOverlap = values[SETTINGS.chunkOverlap];
	const batchSize = values[SETTINGS.embeddingBatchSize];
	const canonMode = values[SETTINGS.canonicalizationMode];
	const canonSim = values[SETTINGS.canonicalSimilarity];
	const granularity = values[SETTINGS.extractionGranularity];
	const concurrency = values[SETTINGS.extractionConcurrency];
	const maxChars = values[SETTINGS.extractionMaxChars];
	const extractionModel = values[SETTINGS.extractionModel];
	const cascade = values[SETTINGS.semanticCascade];
	const cascadeDepth = values[SETTINGS.semanticCascadeDepth];
	const fanoutCap = values[SETTINGS.semanticCascadeFanoutCap];
	const enrichment = values[SETTINGS.enrichmentEnabled];
	return {
		provider: typeof values[SETTINGS.provider] === 'string' ? (values[SETTINGS.provider] as string) : DEFAULT_SETTINGS.provider,
		baseUrl: typeof values[SETTINGS.baseUrl] === 'string' ? (values[SETTINGS.baseUrl] as string) : DEFAULT_SETTINGS.baseUrl,
		model: typeof values[SETTINGS.model] === 'string' ? (values[SETTINGS.model] as string) : DEFAULT_SETTINGS.model,
		connectionTimeoutSeconds:
			typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : DEFAULT_SETTINGS.connectionTimeoutSeconds,
		chunkSize: typeof chunkSize === 'number' && Number.isFinite(chunkSize) ? chunkSize : DEFAULT_SETTINGS.chunkSize,
		chunkOverlap: typeof chunkOverlap === 'number' && Number.isFinite(chunkOverlap) ? chunkOverlap : DEFAULT_SETTINGS.chunkOverlap,
		embeddingBatchSize: typeof batchSize === 'number' && Number.isFinite(batchSize) ? batchSize : DEFAULT_SETTINGS.embeddingBatchSize,
		canonicalizationMode: canonMode === 'embedding' || canonMode === 'exact' ? canonMode : DEFAULT_SETTINGS.canonicalizationMode,
		canonicalSimilarity: typeof canonSim === 'number' && Number.isFinite(canonSim) ? canonSim / 100 : DEFAULT_SETTINGS.canonicalSimilarity,
		extractionGranularity:
			granularity === 'per-note' || granularity === 'per-chunk' || granularity === 'per-note+per-chunk'
				? granularity
				: DEFAULT_SETTINGS.extractionGranularity,
		extractionConcurrency: typeof concurrency === 'number' && Number.isFinite(concurrency) ? concurrency : DEFAULT_SETTINGS.extractionConcurrency,
		extractionMaxChars: typeof maxChars === 'number' && Number.isFinite(maxChars) ? maxChars : DEFAULT_SETTINGS.extractionMaxChars,
		extractionModel: typeof extractionModel === 'string' ? extractionModel : DEFAULT_SETTINGS.extractionModel,
		semanticCascade: cascade === 'eager' || cascade === 'lazy' ? cascade : DEFAULT_SETTINGS.semanticCascade,
		semanticCascadeDepth: typeof cascadeDepth === 'number' && Number.isFinite(cascadeDepth) ? cascadeDepth : DEFAULT_SETTINGS.semanticCascadeDepth,
		semanticCascadeFanoutCap: typeof fanoutCap === 'number' && Number.isFinite(fanoutCap) ? fanoutCap : DEFAULT_SETTINGS.semanticCascadeFanoutCap,
		enrichmentEnabled: typeof enrichment === 'boolean' ? enrichment : DEFAULT_SETTINGS.enrichmentEnabled,
	};
}

function isValidBaseUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}