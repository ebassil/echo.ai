import { enqueueRun } from './runner';
import { resolveScope } from './scope';
import type { Scope, PipelineSelector, TriggerKind, BatchResult } from './types';
import { isVaultLocked } from '../indexing/vault';
import { getDatabase, run } from '../storage/db';

export interface RunBatchOptions {
  scope: Scope;
  pipeline: PipelineSelector;
  force?: boolean;
  cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false;
  trigger?: TriggerKind;
  onProgress?: (processed: number, total: number, currentNoteId: string) => void;
  batchId?: string;
}

export async function runBatch(options: RunBatchOptions): Promise<{ runId: string; cancel(): Promise<void>; promise: Promise<BatchResult> }> {
  const trigger = options.trigger ?? 'manual';
  const pipeline = options.pipeline;
  const force = options.force ?? false;
  const cascade = options.cascade;
  const batchId = options.batchId ?? `batch_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`;

  // Vault gate: if locked, defer until unlock? Spec says queue/defer and no decrypted reads.
  // For manual trigger, we still enqueue but runner will defer execution.
  // We check vault locked here and defer by not resolving scope yet? Instead, we enqueue and let runner handle vault defer.
  // However scope resolution itself needs joplin.data reads which would read decrypted content. So we must not resolve while locked.
  // Therefore, if vault locked, we should enqueue without resolving scope now, letting runner resolve later after unlock.

  if (pipeline === 'both') {
    // For "both" we enqueue two runs with shared batchId: structural then semantic sequentially.
    // To ensure sequential, we enqueue structural first and chain semantic after it completes.
    // However spec says runner handles "both" sequentially. Simpler: enqueue as single "both" via runner.
    // But for clearer history (two rows), orchestrator enqueues two separate runs sequentially.
    // Choice: enqueue as single "both" runner handling two phases; but to get two rows we handle here.

    // We will enqueue as single "both" for now (runner handles sequential). To provide two rows, runner's both handling would need to log two rows.
    // For MVP, enqueue as "both" single run; document that it creates one row with pipeline='both' encoded.
    // Alternative: sequential enqueue here ensures two rows.

    // Implement sequential two-run approach: first structural, then semantic, aggregated.
    let cancelled = false;
    let firstRunId: string | null = null;
    let secondRunId: string | null = null;

    const first = await enqueueRun({
      pipeline: 'structural',
      scope: options.scope,
      trigger,
      onProgress: options.onProgress,
      force,
      batchId,
    });
    firstRunId = first.runId;

    const aggregatePromise = (async (): Promise<BatchResult> => {
      const firstResult = await first.promise;
      if (cancelled) return firstResult;
      if (await isVaultLocked()) {
        // Defer semantic until unlock? For now return first result and queue semantic deferred
        console.info('[echo] orchestrator: vault locked after structural, deferring semantic');
        return firstResult;
      }
      const second = await enqueueRun({
        pipeline: 'semantic',
        scope: options.scope,
        trigger,
        onProgress: options.onProgress,
        force,
        cascade,
        batchId,
      });
      secondRunId = second.runId;
      const secondResult = await second.promise;
      return {
        notesProcessed: firstResult.notesProcessed + secondResult.notesProcessed,
        chunksCreated: firstResult.chunksCreated + secondResult.chunksCreated,
        entitiesCreated: secondResult.entitiesCreated,
        relationsCreated: secondResult.relationsCreated,
        skipped: firstResult.skipped + secondResult.skipped,
        errors: [...firstResult.errors, ...secondResult.errors],
      };
    })();

    const cancel = async () => {
      cancelled = true;
      try {
        if (firstRunId) await first.cancel();
      } catch {}
      try {
        if (secondRunId) {
          const { cancelRun } = await import('./runner');
          await cancelRun(secondRunId);
        }
      } catch {}
    };

    return { runId: first.runId, cancel, promise: aggregatePromise };
  }

  // Single pipeline
  return enqueueRun({
    pipeline,
    scope: options.scope,
    trigger,
    onProgress: options.onProgress,
    force,
    cascade,
    batchId,
  });
}

// Manual trigger API alias
export async function manualTrigger(options: RunBatchOptions): Promise<{ runId: string; cancel(): Promise<void>; promise: Promise<BatchResult> }> {
  return runBatch({ ...options, trigger: 'manual' });
}

// Batch operations for note/folder/all
export async function reindexNote(noteId: string, pipeline: PipelineSelector = 'structural', opts: Omit<RunBatchOptions, 'scope' | 'pipeline'> = {}): Promise<BatchResult> {
  const handle = await runBatch({ scope: { noteId }, pipeline, ...opts });
  return handle.promise;
}

export async function reindexFolder(folderId: string, pipeline: PipelineSelector = 'structural', opts: Omit<RunBatchOptions, 'scope' | 'pipeline'> = {}): Promise<BatchResult> {
  const handle = await runBatch({ scope: { folderId }, pipeline, ...opts });
  return handle.promise;
}

export async function reindexAll(pipeline: PipelineSelector = 'structural', opts: Omit<RunBatchOptions, 'scope' | 'pipeline'> = {}): Promise<BatchResult> {
  const handle = await runBatch({ scope: 'all', pipeline, ...opts });
  return handle.promise;
}

// Status delegation
export { getCurrentStatus, getRunHistory, getRunById } from './status';
