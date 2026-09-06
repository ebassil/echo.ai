import { getOrchestrationTriggers } from '../plugin/runtime';
import type { TriggersHandle } from '../orchestration/triggers';

// Legacy watcher (indexing/watch.ts + events.ts) was superseded by the
// orchestration trigger framework (orchestration/triggers.ts). This module is
// kept as a thin shim so existing callers and the IndexingService contract keep
// working, but all watch behavior is delegated to the single orchestration
// trigger/listener path. Exactly one event-listener registration is active at
// runtime.

export interface WatchOptions {
	provider?: unknown;
	debounceMs?: number;
	onUnlock?: () => Promise<void>;
}

export function getWatchHandle(): TriggersHandle | null {
	return getOrchestrationTriggers();
}

export async function flushWatchQueue(): Promise<void> {
	const triggers = getOrchestrationTriggers();
	if (triggers) await triggers.flush();
}

export async function startWatching(_options: WatchOptions = {}): Promise<TriggersHandle | null> {
	return getOrchestrationTriggers();
}

export async function stopWatching(): Promise<void> {
	// No-op: orchestration triggers are disposed by runtime().stop().
}