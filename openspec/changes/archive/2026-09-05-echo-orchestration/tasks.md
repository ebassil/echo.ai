## 1. Scaffolding and Interfaces

- [x] 1.1 Create `src/orchestration/` module skeleton with barrel exports and the `Pipeline` interface (`run(scope, opts): Promise<PipelineResult>` with `notesProcessed`, `chunksCreated`, `entitiesCreated`, `relationsCreated`, `skipped`, `errors`)
- [x] 1.2 Define orchestration types: `Scope` (`{noteId}` | `{folderId}` | `'all'`), `PipelineSelector` (`'structural'` | `'semantic'` | `'embedding'` | `'both'`), `TriggerKind` (`'manual'` | `'event'` | `'schedule'` | `'startup'`), `Priority` mapping, `RunHandle` (`{ runId, cancel() }`), `BatchResult`
- [x] 1.3 Add `echo.orchestrationSchedule` setting registration in `src/orchestration/settings.ts` (default `off`, accepts interval/cron/`off`, validation with retain-prior-on-invalid)

## 2. Scope Resolver — Single Source of Truth

- [x] 2.1 Implement `src/orchestration/scope.ts` `resolveScope(scope): Promise<NoteId[]>` for single-note (existence check via `joplin.data.get(['notes', id])`), folder-subtree (BFS over folders with descendant collection), and all-notes (paginated `joplin.data.get(['notes'], {fields, page, limit:100})` with yield per page)
- [x] 2.2 Migrate/re-export `src/indexing/scopes.ts` so existing callers still work; `scope.ts` becomes the canonical implementation and all new callers import from `orchestration/scope.ts`
- [x] 2.3 Add unit tests for scope resolver: single-note found/not-found, folder with nested descendants, all-notes pagination, and large-vault yield behavior

## 3. Pipeline Runner — Queue, Priority, Cancellation, Progress, Logging

- [x] 3.1 Implement `src/orchestration/runner.ts` priority queue (manual 3 > event 2 > schedule 1 > startup 0, FIFO within priority), serial execution against the single SQLite connection, and per-note `AbortSignal` cooperative cancellation
- [x] 3.2 Implement progress reporting: `onProgress(processed, total, currentNoteId)` callback invoked after each per-note transaction; queue supports multiple registered listeners
- [x] 3.3 Implement `pipeline_runs` logging: insert on start (`running`), update on finish (`success`/`failed`/`cancelled`, `finished_at`, `notes_processed`, `chunks_created`, `error` truncated to 1k); support `cancel(runId)` for queued (remove + mark `cancelled`) and in-progress (abort after current note)
- [x] 3.4 Adapt `src/indexing/pipeline.ts` and `src/semantic/pipeline.ts` to implement the `Pipeline` interface (wrap existing `indexNote`/`extractNote` per-note loops, check `signal.aborted` between notes, forward `onProgress`)
- [x] 3.5 Add runner unit tests with fake pipelines: queue ordering by priority, cancel queued, cancel in-progress, progress callbacks, and serial-execution invariant

## 4. Trigger Framework — Commands, Events, Vault Gate, Startup

- [x] 4.1 Implement `src/orchestration/triggers.ts` Joplin command registration (`joplin.commands.register` + menu/toolbar items for "Echo: Reindex all", "Echo: Extract semantics (all)", etc.) that enqueue `manual` runs via the runner
- [x] 4.2 Implement debounced note-event wiring in `triggers.ts`: listen to `joplin.workspace.onNoteChange`/`onNoteDelete`, debounce with shared 1200 ms timer deduped by note id, share `enrichmentInFlight` suppression set with `semantic/enrichment.ts` (5 s window)
- [x] 4.3 Implement vault gating in `triggers.ts`: poll `isVaultLocked()` every 3s, defer all triggers while locked (bounded in-memory queue), flush deferred runs on unlock in priority order plus a full delta-scan catch-up
- [x] 4.4 Wire `triggers.ts` into `src/plugin/runtime.ts` (`onStart` registers commands + watch, `onStop` disposes listeners) and migrate `indexing/watch.ts` debounce/vault logic into `triggers.ts` with a compatibility shim

## 5. Scheduler — Interval and Cron

- [x] 5.1 Implement `src/orchestration/scheduler.ts` interval mode: parse interval strings (`30m`, `2h`, `1d`) and schedule `setInterval` ticks that enqueue `schedule`-trigger runs via the runner
- [x] 5.2 Implement cron mode: 5-field cron matcher (pure-JS, 60 s tick) that enqueues at matching wall-clock times; document 1-minute minimum granularity
- [x] 5.3 Wire schedule setting to scheduler: on `echo.orchestrationSchedule` change, cancel prior timer and re-register; `off`/`disabled` disables periodic ticks; ticks respect vault gate (defer while locked)
- [x] 5.4 Add scheduler tests: interval parsing (valid/invalid), cron matching, disable/enable, vault-lock defer, and setting-change re-registration

## 6. Batch Scope Operations

- [x] 6.1 Implement `src/orchestration/orchestrator.ts` `runBatch({ scope, pipeline, force, cascade, onProgress })` facade: resolves scope via `scope.ts`, selects pipeline(s), enqueues via runner, returns `RunHandle`; `pipeline='both'` runs structural then semantic sequentially with a shared `batchId` (two `pipeline_runs` rows or one with `pipeline='both'`, documented)
- [x] 6.2 Support `force` passthrough (bypass content-hash delta) and `cascade` override (per-run `lazy`/`eager` mode) forwarded to pipeline `run` opts
- [x] 6.3 Aggregate batch result counts: `notesProcessed`, `chunksCreated`, `entitiesCreated`, `relationsCreated`, `skipped`, per-note `errors`

## 7. Status and History API

- [x] 7.1 Implement `src/orchestration/status.ts` `getCurrentStatus()` (in-progress run row + queue depth + queued summaries from runner) and `getRunHistory({ pipeline, status, limit, offset })` (filtered `SELECT` over `pipeline_runs`, ordered by `started_at DESC`)
- [x] 7.2 Implement `getRunById(id)` (full `pipeline_runs` row or not-found error); ensure no Joplin data or network access in status paths
- [x] 7.3 Expose status API for CLI and UI consumers (importable from `orchestrator.ts` / `status.ts`); verify existing `pipeline_runs(pipeline, started_at)` index covers history queries

## 8. Integration and Verification

- [x] 8.1 Wire `Orchestrator` lifecycle in `src/plugin/runtime.ts`: `onStart` creates orchestrator (runner + triggers + scheduler), registers all, starts watch/scheduler; `onStop` tears down listeners/timers and aborts in-progress run after current note
- [x] 8.2 Add integration smoke test: enqueue manual + event + schedule runs, verify priority ordering and serial execution; verify vault-lock gate (no decrypted reads while locked, flush on unlock); verify `pipeline_runs` rows for all outcomes (`success`, `failed`, `cancelled`)
- [x] 8.3 Verify plaintext/local-first posture: orchestration writes only to plugin data dir SQLite, no sync, no network exfiltration beyond downstream pipeline's local Ollama calls; confirm no decrypted reads while vault is locked
