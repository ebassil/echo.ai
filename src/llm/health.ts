import type { LLMProvider } from './provider';

export type ProviderHealthStatus = 'up' | 'down' | 'unknown';

export interface ProviderHealth {
	readonly peek: () => ProviderHealthStatus;
	readonly check: (provider: LLMProvider) => Promise<'up' | 'down'>;
	readonly invalidate: () => void;
}

export const upTtlMs = 60_000;
export const downTtlMs = 15_000;
export const probeTimeoutMs = 2_000;

let cached: { status: 'up' | 'down'; at: number } | null = null;
let probePromise: Promise<'up' | 'down'> | null = null;

function statusAgeWithinTtl(): boolean {
	if (!cached) return false;
	const ttl = cached.status === 'up' ? upTtlMs : downTtlMs;
	return Date.now() - cached.at < ttl;
}

function peek(): ProviderHealthStatus {
	if (!cached || !statusAgeWithinTtl()) return 'unknown';
	return cached.status;
}

async function probe(provider: LLMProvider): Promise<'up' | 'down'> {
	try {
		const models = await Promise.race([
			provider.listModels(),
			new Promise<'__echo_timeout__'>((resolve) => setTimeout(() => resolve('__echo_timeout__'), probeTimeoutMs)),
		]);
		return models !== '__echo_timeout__' && models.length > 0 ? 'up' : 'down';
	} catch {
		return 'down';
	}
}

async function check(provider: LLMProvider): Promise<'up' | 'down'> {
	const current = peek();
	if (current !== 'unknown') return current;
	if (probePromise) return probePromise;
	probePromise = probe(provider)
		.then((status) => {
			cached = { status, at: Date.now() };
			return status;
		})
		.finally(() => {
			probePromise = null;
		});
	return probePromise;
}

function invalidate(): void {
	cached = null;
}

export const providerHealth: ProviderHealth = { peek, check, invalidate };

export function __resetProviderHealthForTests(): void {
	cached = null;
	probePromise = null;
}