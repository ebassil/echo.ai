import { errorMessage } from '../../util/errors';
import type {
	ChatMessage,
	ChatOptions,
	ConnectionTestResult,
	ExtractionResult,
	Entity,
	Relation,
	LLMProvider,
	TestConnectionOptions,
} from '../provider';
import { parseSSEStream } from '../sse';

export interface OllamaProviderConfig {
	baseUrl: string;
	model: string;
}

export class OllamaProvider implements LLMProvider {
	readonly name = 'ollama';

	private readonly baseUrl: string;
	private readonly model: string;

	constructor(config: OllamaProviderConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		this.model = config.model;
	}

	async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
		const body: Record<string, any> = {
			model: this.model,
			messages,
		};
		if (options?.temperature !== undefined) body.temperature = options.temperature;
		if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

		const response = await fetch(this.endpoint('/chat/completions'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
		await ensureOk(response, this.baseUrl);

		const data = await response.json();
		const content: unknown = data?.choices?.[0]?.message?.content;
		if (typeof content !== 'string') {
			throw new Error(`Unexpected chat response from ${this.baseUrl}: missing message content`);
		}
		return content;
	}

	async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string, void, void> {
		const body: Record<string, any> = {
			model: this.model,
			messages,
			stream: true,
		};
		if (options?.temperature !== undefined) body.temperature = options.temperature;
		if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

		const response = await fetch(this.endpoint('/chat/completions'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
		await ensureOk(response, this.baseUrl);

		if (!response.body) {
			throw new Error(`Unexpected chat response from ${this.baseUrl}: streaming body unavailable`);
		}

		yield* parseSSEStream(response.body);
	}

	async embeddings(texts: string[]): Promise<number[][]> {
		const response = await fetch(this.endpoint('/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: this.model, input: texts }),
		});
		await ensureOk(response, this.baseUrl);

		const data = await response.json();
		const embeddings: unknown = data?.data?.map((item: any) => item.embedding);
		if (!Array.isArray(embeddings)) {
			throw new Error(`Unexpected embeddings response from ${this.baseUrl}: missing embedding data`);
		}
		return embeddings as number[][];
	}

	async extract(text: string): Promise<ExtractionResult> {
		const messages: ChatMessage[] = [
			{
				role: 'system',
				content:
					'You extract entities and relations from text. Respond only with JSON matching ' +
					'{"entities":[{"name":string,"type":string}],"relations":[{"from":string,"to":string,"type":string}]}.',
			},
			{ role: 'user', content: text },
		];

		const raw = await this.chat(messages, { temperature: 0 });
		return parseExtraction(raw);
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await fetch(this.endpoint('/models'));
			if (!response.ok) return [];
			const data = await response.json();
			const models: string[] = (data?.data ?? [])
				.map((item: any) => (typeof item?.id === 'string' ? item.id : ''))
				.filter((id: string) => id.length > 0);
			return models;
		} catch {
			return [];
		}
	}

	async testConnection(options?: TestConnectionOptions): Promise<ConnectionTestResult> {
		try {
			await options?.onProgress?.(`Contacting provider at ${this.baseUrl}...`, 30);

			const response = await fetch(this.endpoint('/models'), { signal: options?.signal });

			await options?.onProgress?.('Verifying /v1/models endpoint...', 80);

			if (!response.ok) {
				return {
					ok: false,
					message: `Provider returned HTTP ${response.status} at ${this.endpoint('/models')}`,
				};
			}

			const data = await response.json();
			const models: string[] = (data?.data ?? [])
				.map((item: any) => (typeof item?.id === 'string' ? item.id : ''))
				.filter((id: string) => id.length > 0);

			await options?.onProgress?.('Connection test complete.', 100);

			if (models.length === 0) {
				return { ok: false, message: `Provider reachable at ${this.baseUrl} but returned no models` };
			}

			return {
				ok: true,
				message: `Connected to Ollama at ${this.baseUrl}. Available models: ${models.join(', ')}.`,
			};
		} catch (error) {
			if (options?.signal?.aborted) {
				return { ok: false, message: 'Connection test aborted.' };
			}
			return { ok: false, message: `Could not reach provider at ${this.baseUrl}: ${errorMessage(error)}` };
		}
	}

	private endpoint(path: string): string {
		return `${this.baseUrl}/v1${path}`;
	}
}

async function ensureOk(response: Response, baseUrl: string): Promise<void> {
	if (response.ok) return;

	let detail = '';
	try {
		const data = await response.json();
		detail = typeof data?.error?.message === 'string' ? data.error.message : JSON.stringify(data);
	} catch {
		detail = await response.text().catch(() => '');
	}

	throw new Error(`Provider error from ${baseUrl} (HTTP ${response.status}): ${detail}`);
}

export function parseExtraction(raw: string): ExtractionResult {
	const jsonText = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/m, '')
		.trim();

	try {
		const parsed = JSON.parse(jsonText) as { entities?: unknown; relations?: unknown };
		const entitiesRaw = Array.isArray(parsed.entities) ? parsed.entities : [];
		const relationsRaw = Array.isArray(parsed.relations) ? parsed.relations : [];
		const entities: Entity[] = entitiesRaw
			.map((e: any) => {
				if (!e || typeof e.name !== 'string') return null;
				const entity: Entity = { name: e.name, type: typeof e.type === 'string' ? e.type : 'unknown' };
				if (typeof e.confidence === 'number' && isFinite(e.confidence)) entity.confidence = e.confidence;
				return entity;
			})
			.filter((e): e is Entity => e !== null);
		const relations: Relation[] = relationsRaw
			.map((r: any) => {
				if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.type !== 'string') return null;
				const relation: Relation = { from: r.from, to: r.to, type: r.type };
				if (typeof r.confidence === 'number' && isFinite(r.confidence)) relation.confidence = r.confidence;
				return relation;
			})
			.filter((r): r is Relation => r !== null);
		return { entities, relations };
	} catch {
		return { entities: [], relations: [] };
	}
}