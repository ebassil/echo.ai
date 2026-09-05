import type { LLMProvider } from '../llm/provider';
import { createIndexingEvents } from './events';
import { indexAll } from './pipeline';
import { isVaultLocked } from './vault';
import type { EventsHandle } from './events';

let handle: EventsHandle | null = null;
let vaultPollTimer: ReturnType<typeof setInterval> | null = null;
let wasLocked: boolean | null = null;

export interface WatchOptions {
	provider: LLMProvider;
	debounceMs?: number;
	onUnlock?: () => Promise<void>;
}

export async function startWatching(options: WatchOptions): Promise<EventsHandle> {
	if (handle) return handle;

	handle = createIndexingEvents({ provider: options.provider, debounceMs: options.debounceMs });

	// Startup catch-up: delta scan for changes that occurred while plugin was off
	// Defer a tick to allow DB/provider to settle
	setTimeout(async () => {
		if (await isVaultLocked()) {
			wasLocked = true;
			console.info('[echo] indexing watch: vault locked at startup, deferring catch-up');
			return;
		}
		wasLocked = false;
		try {
			console.info('[echo] indexing watch: startup catch-up scan');
			await indexAll(options.provider);
		} catch (e) {
			console.warn('[echo] startup catch-up failed', e);
		}
	}, 1000);

	// Vault lock polling: detect transition from locked -> unlocked
	vaultPollTimer = setInterval(async () => {
		const locked = await isVaultLocked();
		if (wasLocked === true && locked === false) {
			console.info('[echo] vault unlocked, flushing queued indexing and running catch-up');
			try {
				await handle?.flush();
			} catch {}
			try {
				await indexAll(options.provider);
			} catch (e) {
				console.warn('[echo] catch-up after unlock failed', e);
			}
			if (options.onUnlock) {
				try {
					await options.onUnlock();
				} catch {}
			}
		}
		wasLocked = locked;
	}, 3000);

	// Initialize wasLocked
	wasLocked = await isVaultLocked();

	return handle;
}

export async function stopWatching(): Promise<void> {
	if (vaultPollTimer) {
		clearInterval(vaultPollTimer);
		vaultPollTimer = null;
	}
	if (handle) {
		handle.dispose();
		handle = null;
	}
	wasLocked = null;
}

export function getWatchHandle(): EventsHandle | null {
	return handle;
}

export async function flushWatchQueue(): Promise<void> {
	if (handle) await handle.flush();
}
