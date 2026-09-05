import type { EchoSettings } from '../settings/registry';
import type { LLMProvider } from './provider';
import { OllamaProvider } from './providers/ollama';

export function createProvider(settings: EchoSettings): LLMProvider {
	switch (settings.provider) {
		case 'ollama':
			return new OllamaProvider({ baseUrl: settings.baseUrl, model: settings.model });
		default:
			throw new Error(`Unsupported provider "${settings.provider}"`);
	}
}