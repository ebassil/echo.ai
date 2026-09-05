import joplin from 'api';
import { SettingItemType } from 'api/types';

export const SETTINGS = {
	provider: 'echo.provider',
	baseUrl: 'echo.baseUrl',
	model: 'echo.model',
	connectionTimeoutSeconds: 'echo.connectionTimeoutSeconds',
} as const;

export const DEFAULT_SETTINGS: EchoSettings = {
	provider: 'ollama',
	baseUrl: 'http://localhost:11434',
	model: 'llama3',
	connectionTimeoutSeconds: 15,
};

const PROVIDER_OPTIONS: Record<string, string> = {
	ollama: 'Ollama (local)',
};

export interface EchoSettings {
	provider: string;
	baseUrl: string;
	model: string;
	connectionTimeoutSeconds: number;
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
	});
}

export async function resolveSettings(): Promise<SettingsResolution> {
	const raw = await loadSettings();
	const errors = validateSettings(raw);

	const settings: EchoSettings = {
		provider: isValidProvider(raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider,
		baseUrl: isValidBaseUrl(raw.baseUrl) ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
		model: isValidModel(raw.model) ? raw.model : DEFAULT_SETTINGS.model,
		connectionTimeoutSeconds: isValidTimeout(raw.connectionTimeoutSeconds)
			? raw.connectionTimeoutSeconds
			: DEFAULT_SETTINGS.connectionTimeoutSeconds,
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
	]);
	const timeout = values[SETTINGS.connectionTimeoutSeconds];
	return {
		provider: typeof values[SETTINGS.provider] === 'string' ? (values[SETTINGS.provider] as string) : DEFAULT_SETTINGS.provider,
		baseUrl: typeof values[SETTINGS.baseUrl] === 'string' ? (values[SETTINGS.baseUrl] as string) : DEFAULT_SETTINGS.baseUrl,
		model: typeof values[SETTINGS.model] === 'string' ? (values[SETTINGS.model] as string) : DEFAULT_SETTINGS.model,
		connectionTimeoutSeconds:
			typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : DEFAULT_SETTINGS.connectionTimeoutSeconds,
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