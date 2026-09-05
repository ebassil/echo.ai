import joplin from 'api';
import { isVaultLocked } from '../indexing/vault';
import { enqueueRun } from './runner';
import type { TriggerKind, Scope, PipelineSelector } from './types';

export const ENRICHMENT_SUPPRESSION_MS = 5000;

let enrichmentInFlight: Set<string> | null = null;
let suppressionTimestamps: Map<string, number> | null = null;

function getEnrichmentSuppression(): { inFlight: Set<string>; timestamps: Map<string, number> } {
  if (enrichmentInFlight && suppressionTimestamps) return { inFlight: enrichmentInFlight!, timestamps: suppressionTimestamps! };
  try {
    const enrichment = require('../semantic/enrichment');
    if (enrichment.enrichmentInFlight instanceof Set) {
      enrichmentInFlight = enrichment.enrichmentInFlight;
    } else {
      enrichmentInFlight = new Set<string>();
    }
    suppressionTimestamps = new Map<string, number>();
    return { inFlight: enrichmentInFlight!, timestamps: suppressionTimestamps! };
  } catch {
    enrichmentInFlight = new Set<string>();
    suppressionTimestamps = new Map<string, number>();
    return { inFlight: enrichmentInFlight!, timestamps: suppressionTimestamps! };
  }
}

export function isEnrichmentSuppressed(noteId: string): boolean {
  const { inFlight, timestamps } = getEnrichmentSuppression();
  if (inFlight.has(noteId)) return true;
  const ts = timestamps.get(noteId);
  if (ts && Date.now() - ts < ENRICHMENT_SUPPRESSION_MS) return true;
  return false;
}

export interface TriggersHandle {
  dispose(): void;
  flush(): Promise<void>;
  getQueueSize(): number;
  isPaused(): boolean;
}

export interface TriggersOptions {
  debounceMs?: number;
  maxQueueSize?: number;
}

const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

export function createTriggers(options: TriggersOptions = {}): TriggersHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

  const pending = new Map<string, { isDelete: boolean; at: number }>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let vaultPollTimer: ReturnType<typeof setInterval> | null = null;
  let deferredQueue: Array<{ scope: Scope; pipeline: PipelineSelector; trigger: TriggerKind }> = [];
  let wasLocked: boolean | null = null;
  let paused = false;
  let disposed = false;

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, debounceMs);
  }

  function enqueueNoteEvent(noteId: string, isDelete = false): void {
    if (disposed) return;
    if (isEnrichmentSuppressed(noteId)) {
      console.info(`[echo] triggers: skipping ${noteId} - enrichment in flight`);
      return;
    }
    if (pending.size >= maxQueueSize && !pending.has(noteId)) {
      const firstKey = pending.keys().next().value as string | undefined;
      if (firstKey) {
        pending.delete(firstKey);
        const t = debounceTimers.get(firstKey);
        if (t) clearTimeout(t);
        debounceTimers.delete(firstKey);
        console.warn(`[echo] triggers: queue full, dropped ${firstKey}`);
      }
    }
    pending.set(noteId, { isDelete, at: Date.now() });
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
      // Move pending to deferred
      for (const [noteId, info] of pending) {
        if (info.isDelete) {
          deferredQueue.push({ scope: { noteId }, pipeline: 'structural' as PipelineSelector, trigger: 'event' });
        } else {
          deferredQueue.push({ scope: { noteId }, pipeline: 'structural' as PipelineSelector, trigger: 'event' });
        }
      }
      console.info('[echo] triggers: vault locked, deferred', pending.size, 'events');
      pending.clear();
      return;
    }
    paused = false;
    const batch = new Map(pending);
    pending.clear();
    for (const [noteId, info] of batch) {
      try {
        if (info.isDelete) {
          // Purge via runner or direct? Use runner with pipeline structural and note scope but purge path
          // For delete, we enqueue a manual purge? For now enqueue structural reindex which will handle purge via delta check (note not found -> purge)
          // Alternative: directly call purgeDeletedNote via pipeline executor; but runner will resolve scope and fail.
          // So handle delete by direct DB purge outside runner
          const { getDatabase } = await import('../storage/db');
          const { purgeNote } = await import('../indexing/delta');
          const { purgeGraphForNote } = await import('../indexing/graphWriter');
          const { withPerNoteTransaction } = await import('../indexing/persist');
          const db = getDatabase();
          await withPerNoteTransaction(db, async () => {
            await purgeNote(db, noteId);
            await purgeGraphForNote(db, noteId);
          });
          // Also purge semantic
          try {
            const { deleteSemanticForNote } = await import('../semantic/persist');
            await deleteSemanticForNote(db, noteId);
          } catch {}
        } else {
          await enqueueRun({
            pipeline: 'structural',
            scope: { noteId },
            trigger: 'event',
          });
        }
      } catch (e) {
        console.warn(`[echo] triggers flush failed for ${noteId}`, e);
      }
    }
  }

  // Joplin workspace listeners
  let onNoteChangeHandler: any = null;
  let onSyncCompleteHandler: any = null;

  try {
    const joplinAny: any = joplin as any;
    if (joplinAny.workspace && typeof joplinAny.workspace.onNoteChange === 'function') {
      onNoteChangeHandler = joplinAny.workspace.onNoteChange(async (event: any) => {
        const noteId = typeof event === 'string' ? event : event?.id;
        if (!noteId) return;
        enqueueNoteEvent(noteId, false);
      });
    }
    if (joplinAny.workspace && typeof joplinAny.workspace.onSyncComplete === 'function') {
      onSyncCompleteHandler = joplinAny.workspace.onSyncComplete(async () => {
        await flush();
      });
    }
  } catch {}

  // Vault polling every 3s
  (async () => {
    wasLocked = await isVaultLocked();
  })();

  vaultPollTimer = setInterval(async () => {
    const locked = await isVaultLocked();
    if (wasLocked === true && locked === false) {
      console.info('[echo] triggers: vault unlocked, flushing deferred and catch-up');
      // Flush deferred queue in priority order
      const toFlush = [...deferredQueue];
      deferredQueue = [];
      for (const item of toFlush) {
        try {
          await enqueueRun({
            pipeline: item.pipeline,
            scope: item.scope,
            trigger: item.trigger,
          });
        } catch {}
      }
      // Full delta scan catch-up
      try {
        await enqueueRun({ pipeline: 'structural', scope: 'all', trigger: 'startup' });
      } catch (e) {
        console.warn('[echo] startup catch-up after unlock failed', e);
      }
      // Also flush watch queue if any
      try {
        await flush();
      } catch {}
      paused = false;
    }
    wasLocked = locked;
  }, 3000);

  return {
    dispose() {
      disposed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (vaultPollTimer) clearInterval(vaultPollTimer);
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
    async flush() {
      await flush();
    },
    getQueueSize() {
      return pending.size + deferredQueue.length;
    },
    isPaused() {
      return paused;
    },
  };
}

let globalHandle: TriggersHandle | null = null;

export function startGlobalTriggers(options: TriggersOptions = {}): TriggersHandle {
  if (globalHandle) return globalHandle;
  globalHandle = createTriggers(options);
  return globalHandle;
}

export function stopGlobalTriggers(): void {
  if (globalHandle) {
    globalHandle.dispose();
    globalHandle = null;
  }
}

export function getGlobalTriggers(): TriggersHandle | null {
  return globalHandle;
}
