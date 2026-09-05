import { getDatabase, run, all } from '../storage/db';
import { errorMessage } from '../util/errors';
import type { Scope, PipelineSelector, TriggerKind, PipelineResult, PipelineRunOptions, BatchResult } from './types';
import { PRIORITY_MAP } from './types';

export interface QueuedRun {
  id: string;
  pipeline: PipelineSelector;
  scope: Scope;
  trigger: TriggerKind;
  priority: number;
  enqueuedAt: string;
  signal: AbortSignal;
  controller: AbortController;
  onProgress?: (processed: number, total: number, currentNoteId: string) => void;
  resolve: (result: BatchResult) => void;
  reject: (error: Error) => void;
  force?: boolean;
  cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false;
  batchId?: string;
}

export interface CurrentRunInfo {
  id: string;
  pipeline: PipelineSelector;
  trigger: TriggerKind;
  scope: Scope;
  startedAt: string;
  priority: number;
  batchId?: string;
}

export type PipelineExecutor = (
  pipeline: PipelineSelector,
  noteIds: string[],
  options: PipelineRunOptions,
) => Promise<PipelineResult>;

let queue: QueuedRun[] = [];
let currentRun: CurrentRunInfo | null = null;
let currentController: AbortController | null = null;
let runningPromise: Promise<void> | null = null;
let progressListeners: Array<(processed: number, total: number, currentNoteId: string) => void> = [];
let latestProgress: { processed: number; total: number; currentNoteId: string } | null = null;

let executor: PipelineExecutor | null = null;

export function setPipelineExecutor(fn: PipelineExecutor): void {
  executor = fn;
}

export function getPipelineExecutor(): PipelineExecutor | null {
  return executor;
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function writePipelineRunRow(
  db: any,
  params: {
    id: string;
    pipeline: string;
    trigger: string;
    scope: Scope;
    status: string;
    startedAt: string;
    finishedAt?: string | null;
    notesProcessed?: number;
    chunksCreated?: number;
    error?: string | null;
    batchId?: string;
  },
): Promise<void> {
  const allowedPipelines = ['structural', 'semantic', 'embedding'];
  let pipeline = params.pipeline;
  let scopeJson: string;
  if (params.pipeline === 'both') {
    // For "both" we store as structural/semantic separately; but if called as single, store as structural for CHECK constraint
    // Instead, store with pipeline='structural' and encode batchId
    pipeline = 'structural';
    scopeJson = JSON.stringify({ scope: params.scope, batchId: params.batchId, originalPipeline: 'both' });
  } else {
    scopeJson = JSON.stringify(params.scope);
    if (params.batchId) {
      const obj = typeof params.scope === 'string' ? { scope: params.scope } : { scope: params.scope };
      scopeJson = JSON.stringify({ ...obj, batchId: params.batchId });
    }
    if (!allowedPipelines.includes(pipeline)) pipeline = 'structural';
  }

  // If status is running, insert
  if (params.status === 'running') {
    try {
      await run(
        db,
        `INSERT INTO pipeline_runs (id, pipeline, trigger, scope, status, started_at, finished_at, notes_processed, chunks_created, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.id,
          pipeline,
          params.trigger,
          scopeJson,
          params.status,
          params.startedAt,
          params.finishedAt ?? null,
          params.notesProcessed ?? 0,
          params.chunksCreated ?? 0,
          params.error ? params.error.slice(0, 1000) : null,
        ],
      );
    } catch (e) {
      console.warn('[echo] failed to insert pipeline_runs', e);
    }
    return;
  }
  // For updates, we need to update existing row. If original was 'both' we inserted as structural, so update that.
  try {
    await run(
      db,
      `UPDATE pipeline_runs SET status = ?, finished_at = ?, notes_processed = ?, chunks_created = ?, error = ? WHERE id = ?`,
      [
        params.status,
        params.finishedAt ?? nowIso(),
        params.notesProcessed ?? 0,
        params.chunksCreated ?? 0,
        params.error ? params.error.slice(0, 1000) : null,
        params.id,
      ],
    );
  } catch (e) {
    console.warn('[echo] failed to update pipeline_runs', e);
  }
}

function dequeue(): QueuedRun | undefined {
  if (queue.length === 0) return undefined;
  // Sort by priority desc then FIFO (enqueuedAt asc)
  queue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.enqueuedAt.localeCompare(b.enqueuedAt);
  });
  return queue.shift();
}

async function processNext(): Promise<void> {
  if (runningPromise) return;
  const next = dequeue();
  if (!next) return;

  runningPromise = (async () => {
    const db = getDatabase();
    const startedAt = nowIso();
    currentRun = {
      id: next.id,
      pipeline: next.pipeline,
      trigger: next.trigger,
      scope: next.scope,
      startedAt,
      priority: next.priority,
      batchId: next.batchId,
    };
    currentController = next.controller;
    latestProgress = null;

    await writePipelineRunRow(db, {
      id: next.id,
      pipeline: next.pipeline,
      trigger: next.trigger,
      scope: next.scope,
      status: 'running',
      startedAt,
      batchId: next.batchId,
    });

    // Handle cancellation before start (queued cancel)
    if (next.signal.aborted) {
      await writePipelineRunRow(db, {
        id: next.id,
        pipeline: next.pipeline,
        trigger: next.trigger,
        scope: next.scope,
        status: 'cancelled',
        startedAt,
        finishedAt: nowIso(),
        batchId: next.batchId,
      });
      next.reject(new Error('Cancelled before start'));
      currentRun = null;
      currentController = null;
      runningPromise = null;
      void processNext();
      return;
    }

    // Resolve noteIds via scope resolver (lazy import to avoid cycle)
    let noteIds: string[] = [];
    try {
      const { resolveScope } = await import('./scope');
      noteIds = await resolveScope(next.scope);
    } catch (e) {
      const msg = errorMessage(e);
      await writePipelineRunRow(db, {
        id: next.id,
        pipeline: next.pipeline,
        trigger: next.trigger,
        scope: next.scope,
        status: 'failed',
        startedAt,
        finishedAt: nowIso(),
        error: msg,
        batchId: next.batchId,
      });
      next.reject(new Error(msg));
      currentRun = null;
      currentController = null;
      runningPromise = null;
      void processNext();
      return;
    }

    // If pipeline is both, we need to run structural then semantic as two phases but single run id? Spec says two rows with shared batchId.
    // For runner, we treat "both" as sequential pipeline calls; we log one row but caller (orchestrator) handles two runs. Here we handle both as sequential.
    try {
      if (!executor) {
        throw new Error('No pipeline executor configured');
      }

      let aggregate: PipelineResult = {
        notesProcessed: 0,
        chunksCreated: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
        skipped: 0,
        errors: [],
      };

      const onProgressWrapped = (processed: number, total: number, currentNoteId: string) => {
        latestProgress = { processed, total, currentNoteId };
        if (next.onProgress) next.onProgress(processed, total, currentNoteId);
        for (const l of progressListeners) l(processed, total, currentNoteId);
      };

      if (next.pipeline === 'both') {
        // Run structural then semantic
        const structuralResult = await executor('structural', noteIds, {
          signal: next.signal,
          onProgress: onProgressWrapped,
          force: next.force,
        });
        if (next.signal.aborted) throw new Error('Cancelled');
        aggregate.notesProcessed += structuralResult.notesProcessed;
        aggregate.chunksCreated += structuralResult.chunksCreated;
        aggregate.skipped += structuralResult.skipped;
        aggregate.errors.push(...structuralResult.errors);

        const semanticResult = await executor('semantic', noteIds, {
          signal: next.signal,
          onProgress: onProgressWrapped,
          force: next.force,
          cascade: next.cascade,
        });
        if (next.signal.aborted) throw new Error('Cancelled');
        aggregate.notesProcessed += semanticResult.notesProcessed;
        aggregate.chunksCreated += semanticResult.chunksCreated;
        aggregate.entitiesCreated += semanticResult.entitiesCreated;
        aggregate.relationsCreated += semanticResult.relationsCreated;
        aggregate.skipped += semanticResult.skipped;
        aggregate.errors.push(...semanticResult.errors);
      } else {
        const result = await executor(next.pipeline, noteIds, {
          signal: next.signal,
          onProgress: onProgressWrapped,
          force: next.force,
          cascade: next.cascade,
        });
        if (next.signal.aborted) throw new Error('Cancelled');
        aggregate = result;
      }

      // Check abort after
      if (next.signal.aborted) {
        await writePipelineRunRow(db, {
          id: next.id,
          pipeline: next.pipeline,
          trigger: next.trigger,
          scope: next.scope,
          status: 'cancelled',
          startedAt,
          finishedAt: nowIso(),
          notesProcessed: aggregate.notesProcessed,
          chunksCreated: aggregate.chunksCreated,
          error: 'Cancelled',
          batchId: next.batchId,
        });
        next.resolve({
          notesProcessed: aggregate.notesProcessed,
          chunksCreated: aggregate.chunksCreated,
          entitiesCreated: aggregate.entitiesCreated,
          relationsCreated: aggregate.relationsCreated,
          skipped: aggregate.skipped,
          errors: aggregate.errors,
        });
      } else {
        const finalStatus = aggregate.errors.length > 0 && aggregate.notesProcessed === 0 ? 'failed' : 'success';
        const errorMsg = aggregate.errors.length > 0 ? aggregate.errors[0].message : null;
        await writePipelineRunRow(db, {
          id: next.id,
          pipeline: next.pipeline,
          trigger: next.trigger,
          scope: next.scope,
          status: finalStatus,
          startedAt,
          finishedAt: nowIso(),
          notesProcessed: aggregate.notesProcessed,
          chunksCreated: aggregate.chunksCreated,
          error: errorMsg,
          batchId: next.batchId,
        });
        next.resolve({
          notesProcessed: aggregate.notesProcessed,
          chunksCreated: aggregate.chunksCreated,
          entitiesCreated: aggregate.entitiesCreated,
          relationsCreated: aggregate.relationsCreated,
          skipped: aggregate.skipped,
          errors: aggregate.errors,
        });
      }
    } catch (e) {
      const msg = errorMessage(e);
      const isCancelled = next.signal.aborted || msg === 'Cancelled';
      await writePipelineRunRow(db, {
        id: next.id,
        pipeline: next.pipeline,
        trigger: next.trigger,
        scope: next.scope,
        status: isCancelled ? 'cancelled' : 'failed',
        startedAt,
        finishedAt: nowIso(),
        error: msg,
        batchId: next.batchId,
      });
      if (isCancelled) {
        next.resolve({
          notesProcessed: 0,
          chunksCreated: 0,
          entitiesCreated: 0,
          relationsCreated: 0,
          skipped: 0,
          errors: [{ noteId: '__cancel__', message: msg }],
        });
      } else {
        next.reject(e as Error);
      }
    } finally {
      currentRun = null;
      currentController = null;
      runningPromise = null;
      void processNext();
    }
  })();

  await runningPromise;
}

export async function enqueueRun(options: {
  pipeline: PipelineSelector;
  scope: Scope;
  trigger: TriggerKind;
  onProgress?: (processed: number, total: number, currentNoteId: string) => void;
  force?: boolean;
  cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false;
  batchId?: string;
}): Promise<{ runId: string; cancel(): Promise<void>; promise: Promise<BatchResult> }> {
  const id = generateRunId();
  const controller = new AbortController();
  const priority = PRIORITY_MAP[options.trigger];

  let resolve!: (result: BatchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BatchResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const queued: QueuedRun = {
    id,
    pipeline: options.pipeline,
    scope: options.scope,
    trigger: options.trigger,
    priority,
    enqueuedAt: nowIso(),
    signal: controller.signal,
    controller,
    onProgress: options.onProgress,
    resolve,
    reject,
    force: options.force,
    cascade: options.cascade,
    batchId: options.batchId,
  };

  queue.push(queued);
  // If not running, start processing
  if (!runningPromise) {
    void processNext();
  }

  const cancel = async () => {
    // If queued, remove
    const idx = queue.findIndex((q) => q.id === id);
    if (idx !== -1) {
      const removed = queue.splice(idx, 1)[0];
      // Write cancelled row
      try {
        const db = getDatabase();
        await writePipelineRunRow(db, {
          id,
          pipeline: removed.pipeline,
          trigger: removed.trigger,
          scope: removed.scope,
          status: 'cancelled',
          startedAt: nowIso(),
          finishedAt: nowIso(),
          batchId: removed.batchId,
        });
      } catch {}
      removed.reject(new Error('Cancelled'));
      // Resolve promise as cancelled counts
      removed.resolve({
        notesProcessed: 0,
        chunksCreated: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
        skipped: 0,
        errors: [{ noteId: '__cancel__', message: 'Cancelled while queued' }],
      });
      return;
    }
    // If current, abort
    if (currentRun && currentRun.id === id && currentController) {
      currentController.abort();
    }
  };

  return { runId: id, cancel, promise };
}

export async function cancelRun(runId: string): Promise<boolean> {
  const idx = queue.findIndex((q) => q.id === runId);
  if (idx !== -1) {
    const removed = queue.splice(idx, 1)[0];
    try {
      const db = getDatabase();
      await writePipelineRunRow(db, {
        id: runId,
        pipeline: removed.pipeline,
        trigger: removed.trigger,
        scope: removed.scope,
        status: 'cancelled',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        batchId: removed.batchId,
      });
    } catch {}
    removed.resolve({
      notesProcessed: 0,
      chunksCreated: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      skipped: 0,
      errors: [{ noteId: '__cancel__', message: 'Cancelled while queued' }],
    });
    removed.reject(new Error('Cancelled'));
    return true;
  }
  if (currentRun && currentRun.id === runId && currentController) {
    currentController.abort();
    return true;
  }
  return false;
}

export function getQueueSnapshot(): QueuedRun[] {
  return [...queue];
}

export function getCurrentRun(): CurrentRunInfo | null {
  return currentRun ? { ...currentRun } : null;
}

export function getQueueDepth(): number {
  return queue.length;
}

export function getProgress(): { processed: number; total: number; currentNoteId: string } | null {
  return latestProgress ? { ...latestProgress } : null;
}

export function addProgressListener(fn: (processed: number, total: number, currentNoteId: string) => void): () => void {
  progressListeners.push(fn);
  return () => {
    progressListeners = progressListeners.filter((l) => l !== fn);
  };
}

export function clearQueue(): void {
  queue = [];
}

export function resetRunner(): void {
  queue = [];
  currentRun = null;
  currentController = null;
  runningPromise = null;
  latestProgress = null;
  progressListeners = [];
}

export function isRunnerBusy(): boolean {
  return runningPromise !== null;
}
