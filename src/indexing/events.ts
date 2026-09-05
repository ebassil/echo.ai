import joplin from 'api';
import { indexNote, purgeDeletedNote } from './pipeline';
import type { LLMProvider } from '../llm/provider';
import { isVaultLocked } from './vault';

// Lazy import for enrichment to avoid circular deps - dynamic check
function isEnrichmentInFlight(noteId: string): boolean {
	try {
		const enrichment = require('../semantic/enrichment');
		if (enrichment && typeof enrichment.isEnrichmentInFlight === 'function') {
			return enrichment.isEnrichmentInFlight(noteId);
		}
	} catch {}
	return false;
}

export interface EventsOptions {
	debounceMs?: number;
	maxQueueSize?: number;
	provider: LLMProvider;
}

export interface EventsHandle {
	dispose(): void;
	enqueue(noteId: string, isDelete?: boolean): void;
	flush(): Promise<void>;
	getQueueSize(): number;
	isPaused(): boolean;
}

const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

export function createIndexingEvents(options: EventsOptions): EventsHandle {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

	const pending = new Map<string, { isDelete: boolean }>();
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let disposed = false;
	let paused = false;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleFlush(): void {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			void flush();
		}, debounceMs);
	}

	function enqueue(noteId: string, isDelete = false): void {
		if (disposed) return;
		if (isEnrichmentInFlight(noteId)) {
			console.info(`[echo] skipping enqueue for ${noteId} - enrichment in flight`);
			return;
		}

		if (pending.size >= maxQueueSize && !pending.has(noteId)) {
			// Evict oldest
			const firstKey = pending.keys().next().value as string | undefined;
			if (firstKey) {
				pending.delete(firstKey);
				const t = debounceTimers.get(firstKey);
				if (t) clearTimeout(t);
				debounceTimers.delete(firstKey);
				console.warn(`[echo] indexing event queue full, dropped ${firstKey}`);
			}
		}

		// Coalesce
		pending.set(noteId, { isDelete: isDelete || (pending.get(noteId)?.isDelete ?? false) });

		const existing = debounceTimers.get(noteId);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			debounceTimers.delete(noteId);
			scheduleFlush();
		}, debounceMs);
		debounceTimers.set(noteId, timer);
	}

	async function flush(): Promise<void> {
		if (pending.size === 0) return;
		if (await isVaultLocked()) {
			paused = true;
			console.info('[echo] indexing paused: vault locked, queue size', pending.size);
			return;
		}
		paused = false;

		// Snapshot and clear
		const batch = new Map(pending);
		pending.clear();

		for (const [noteId, info] of batch) {
			if (info.isDelete) {
				try {
					await purgeDeletedNote(noteId);
				} catch (e) {
					console.warn(`[echo] purge failed for ${noteId}`, e);
				}
			} else {
				try {
					await indexNote(noteId, options.provider);
				} catch (e) {
					console.warn(`[echo] indexNote failed for ${noteId}`, e);
				}
			}
		}
	}

	// Register Joplin workspace events if available
	let onNoteChangeHandler: any = null;
	let onSyncCompleteHandler: any = null;

	try {
		const joplinAny: any = joplin as any;
		if (joplinAny.workspace && typeof joplinAny.workspace.onNoteChange === 'function') {
			onNoteChangeHandler = joplinAny.workspace.onNoteChange(async (event: any) => {
				// event may be { id, event } or just id string
				const noteId = typeof event === 'string' ? event : event?.id;
				if (!noteId) return;
				// Heuristic: Joplin doesn't always distinguish delete; we treat as upsert and let pipeline handle not-found
				enqueue(noteId, false);
			});
		}
		if (joplinAny.workspace && typeof joplinAny.workspace.onSyncComplete === 'function') {
			onSyncCompleteHandler = joplinAny.workspace.onSyncComplete(async () => {
				// On sync complete, pending queue may have stale ids; flush
				await flush();
			});
		}
	} catch {
		// Workspace events not available, fallback is manual enqueue only
	}

	return {
		dispose() {
			disposed = true;
			if (flushTimer) clearTimeout(flushTimer);
			for (const t of debounceTimers.values()) clearTimeout(t);
			debounceTimers.clear();
			pending.clear();
			try {
				if (onNoteChangeHandler && typeof onNoteChangeHandler.remove === 'function') onNoteChangeHandler.remove();
			} catch {}
			try {
				if (onSyncCompleteHandler && typeof onSyncCompleteHandler.remove === 'function') onSyncCompleteHandler.remove();
			} catch {}
		},
		enqueue,
		async flush() {
			await flush();
		},
		getQueueSize() {
			return pending.size;
		},
		isPaused() {
			return paused;
		},
	};
}
