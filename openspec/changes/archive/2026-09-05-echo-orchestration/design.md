## Context

`echo-foundation` (archived) provides the plugin shell (`src/plugin/runtime.ts`), a single shared SQLite connection via `joplin.require('sqlite3')` (`src/storage/db.ts`), versioned migrations, and the Ollama provider (`src/llm/provider.ts`). `echo-schema` (archived) ships migration v2 with all domain tables including `pipeline_runs` and `index_state`. `echo-indexing` lands the structural pipeline (`src/indexing/` — chunker, graph writer, embedder, delta, watch, scopes, per-note transactions, vault gating). `echo-semantic-graph` lands the semantic pipeline (`src/semantic/` — extractor, canonicalize, evidence, cascade, enrichment, per-note transactions, vault gating) plus migration v3 (`relation_evidence`, `source` discriminator).

Both pipelines currently expose their own `watch.ts` / trigger wiring, scope helpers, and ad-hoc `pipeline_runs` writes. No shared runner, scheduler, or typed status API exists. This change introduces `src/orchestration/` as the single coordination surface that callers (`echo-cli`, `echo-config-ui`, `echo-chat`/`echo-retrieval`) consume, and that both pipelines are invoked through.

See proposal.md - Why for motivation and `specs/orchestration/spec.md` for normative requirements.

## Goals / Non-Goals

**Goals:**
- A serial runner that owns the SQLite write path: queue, priority, cancellation, progress, and canonical `pipeline_runs` logging
- A unified trigger framework that supersedes `indexing/watch.ts` event wiring: Joplin commands, debounced note events, vault-unlock/startup catch-up, and a configurable interval/cron scheduler
- Batch scope operations (`note` / `folder` subtree / `all`) and pipeline selection (`structural` | `semantic` | `both`) with force/ cascade overrides
- A single scope resolver (`src/orchestration/scope.ts`) that replaces duplicated folder-tree and pagination logic
- Read-only status/history queries over `pipeline_runs` for CLI and UI

**Non-Goals:**
- Retrieval (RRF, token-budget context), graph view, or chat — downstream consumers of status only
- New LLM provider implementations — pipelines already call `provider.embeddings` / `provider.extract` against local Ollama
- New DDL beyond `pipeline_runs`/`index_state` (scheduler state is in-memory with settings-backed config)
- Remote sync or network exfiltration — orchestration is local-only per security posture

## Decisions

### Module location: `src/orchestration/`
New module `src/orchestration/` exposing `orchestrator.ts` (facade), `runner.ts`, `scheduler.ts`, `triggers.ts`, `scope.ts`, `status.ts`, `settings.ts`. Pipelines stay in `src/indexing/` and `src/semantic/` and are invoked through the runner; `indexing/watch.ts` event wiring migrates into `triggers.ts`.

- **Why:** Mirrors capability `orchestration`; isolates scheduling/queueing from pipeline logic the way `indexing` and `semantic` are isolated from each other. Callers depend only on `orchestrator.ts` + `status.ts`.
- **Alternative:** Extend `src/indexing/` with runner/scheduler — couples orchestration to the first pipeline and makes semantic triggering a second-class citizen. Rejected.

### Runner: serial queue with priority and cooperative cancellation
`runner.ts` holds an in-memory priority queue (`manual` 3 > `event` 2 > `schedule` 1 > `startup` 0; FIFO within priority). One `currentRun: Promise<void> | null` executes at a time against the single SQLite connection. Enqueued items are `{ id, pipeline, scope, trigger, priority, signal: AbortSignal, onProgress }`. Dequeue picks the highest priority. `cancel(runId)` either removes a queued item (mark `cancelled`) or aborts the in-progress run via `AbortController`. Pipelines cooperate by checking `signal.aborted` between per-note transactions (the natural atomic boundary from `persist.ts:9` `withPerNoteTransaction`).

- **Why:** SQLite has a single writer; serial execution is the only correct mapping. Priority ensures user-initiated `manual` runs are not starved by periodic `schedule` ticks. Per-note abort granularity matches the existing transaction boundary so no partial note is left in the DB.
- **Alternative:** Parallel pipeline execution with separate connections — violates the shared-connection invariant from `echo-foundation` and risks `SQLITE_BUSY`. Rejected.
- **Alternative:** Immediate `abort()` mid-transaction — would roll back the per-note transaction but leaves `index_state` ambiguous; aborting between transactions is cleaner. Rejected.

### Trigger framework: unified `triggers.ts` owning all event wiring
`triggers.ts` registers:
1. Joplin commands via `joplin.commands.register` + `joplin.views.menuItems.create` / `joplin.views.toolbarButtons.create` (e.g., "Echo: Reindex all", "Echo: Extract semantics (all)").
2. Joplin workspace listeners (`joplin.workspace.onNoteChange` / `onNoteDelete` where available) with the same debounce coalescing as `indexing/watch.ts` (shared timer, default 1200 ms, deduped by note id).
3. Vault polling (`isVaultLocked()` every 3s as in `indexing/watch.ts:40` / `semantic/cascade.ts`) — deferred runs are held in a bounded in-memory queue and flushed on unlock.
4. App-start hook from `plugin/runtime.ts` (`onStart` → enqueue `startup` delta scan if unlocked, else defer).

`indexing/watch.ts` debounce and vault-gate logic is moved into `triggers.ts` (or `triggers.ts` delegates to it) so there is one watch path. The enrichment suppression set (`enrichmentInFlight`, 5 s window from `semantic/enrichment.ts`) is shared with `triggers.ts` so enrichment writes do not re-enqueue.

- **Why:** One watch path prevents double-enqueue (structural vs semantic) and makes vault gating consistent. Reusing the proven debounce + polling pattern minimizes new failure modes.
- **Alternative:** Keep separate `indexing/watch.ts` and `semantic/watch.ts` — duplicates vault polling and risks ordering bugs. Rejected.

### Scheduler: settings-backed interval/cron with in-process timers
`scheduler.ts` reads `echo.orchestrationSchedule` (default `off`). Accepted values: `off`/`disabled`, interval strings (`30m`, `2h`, `1d`), or 5-field cron (`0 */6 * * *`). Implementation: for intervals, `setInterval`; for cron, a small pure-JS cron matcher (e.g., `cron-parser` or hand-rolled 5-field evaluator) checked on a 60 s tick. No new table; schedule config lives in Joplin settings. Changing the setting cancels the prior timer and re-registers. Ticks enqueue through `runner.ts` with `trigger='schedule'` and respect the vault gate (defer while locked).

- **Why:** Pure-JS, no native deps, no new DDL. Fits the project's "prefer pure-JS" constraint. Interval covers the common case; cron is a small incremental addition for power users.
- **Alternative:** Persist next-run time in SQLite and use `setTimeout` per run — more durable across restarts but restarts already re-evaluate schedule on `onStart`, so durability adds little. Rejected for now.
- **Alternative:** Bundle `node-cron` — heavier, still needs vault gating. A tiny matcher is sufficient. Rejected.

### Batch scope operations and pipeline selection
`orchestrator.ts` exposes `runBatch({ scope, pipeline, force, cascade, onProgress }): Promise<BatchResult>` where `scope` is `{ noteId } | { folderId } | 'all'`, `pipeline` is `'structural' | 'semantic' | 'both'`, and `force`/`cascade` override delta and cascade mode for that run. For `both`, it enqueues one logical batch that runs structural then semantic sequentially, logging either two `pipeline_runs` rows with a shared `batchId` or one row with `pipeline='both'` (pick one and document it; recommend two rows with `batchId` for clearer per-pipeline history). Folder scope delegates to `scope.ts` for descendant resolution; note/all delegate similarly.

- **Why:** Single entry point for CLI and UI; pipeline selection is explicit so callers can run structural without paying semantic LLM cost.
- **Alternative:** Separate `reindexNote` / `extractNote` methods per pipeline — more surface, callers still need a `both` helper. A unified `runBatch` is more ergonomic. Rejected.

### Scope resolver: single source of truth `scope.ts`
`scope.ts` exports `resolveScope(scope): Promise<NoteId[]>` handling the three cases:
- `noteId`: `joplin.data.get(['notes', id])` existence check.
- `folderId`: BFS over `joplin.data.get(['folders'])` parent relations to collect descendant ids, then `joplin.data.get(['folders', fid, 'notes'])` or paginated note fetch filtered by `parent_id`.
- `all`: paginated `joplin.data.get(['notes'], { fields, page, limit: 100 })`.

This replaces `indexing/scopes.ts` (which `scope.ts` either moves or wraps). Large vaults yield with `await setTimeout(0)` per page as in `indexing/pipeline.ts`.

- **Why:** Eliminates duplicated folder-tree and pagination logic; the proposal explicitly calls for scope semantics as the single source of truth.
- **Alternative:** Keep `indexing/scopes.ts` and `semantic/scopes.ts` separate — drift risk. Rejected.

### Status and history: `status.ts` as read-only SQLite view
`status.ts` exposes `getCurrentStatus(): Promise<{ currentRun, queue }>` and `getRunHistory({ pipeline, status, limit, offset })` plus `getRunById(id)`. Queries are `SELECT ... FROM pipeline_runs WHERE ... ORDER BY started_at DESC LIMIT ? OFFSET ?` using the existing `pipeline_runs(pipeline, started_at)` index. No Joplin data or network access. Queue depth and queued summaries come from `runner.ts` in-memory state.

- **Why:** CLI and UI need status without coupling to runner internals; read-only SQLite queries are cheap and consistent with the existing `pipeline_runs` contract.
- **Alternative:** Expose runner's in-memory state only — loses history across restarts. Rejected.

### Pipeline invocation contract
Runner invokes pipelines via a `Pipeline` interface: `run(scope: NoteId[], opts: { signal, onProgress, force, cascade }): Promise<PipelineResult>` where `PipelineResult` is `{ notesProcessed, chunksCreated, entitiesCreated, relationsCreated, errors }`. `src/indexing/pipeline.ts` and `src/semantic/pipeline.ts` are adapted to implement it (currently they expose `indexNote`/`indexAll`-style functions). This keeps `runner.ts` pipeline-agnostic and lets `both` be a sequential composition.

- **Why:** One abstraction for both pipelines; runner does not import pipeline internals beyond the interface. Easier to test with fake pipelines.
- **Alternative:** Runner directly calls `indexNote`/`extractNote` per note — leaks scope resolution into runner and duplicates per-note loop logic. Rejected.

### Migration plan
No new migration. `pipeline_runs` and `index_state` already exist (v2/v3). Scheduler config is in Joplin settings; runner queue is in-memory (lost on restart, re-hydrated by startup delta scan). `indexing/watch.ts` wiring migrates into `orchestration/triggers.ts` with a deprecation shim if needed.

## Risks / Trade-offs

- [Runner is SPOF for all indexing] → Bug in `runner.ts` blocks both pipelines. Mitigate with small, tested interface (`Pipeline` type), unit tests with fake pipelines, and fallback: direct pipeline calls still work if runner is bypassed in emergency (documented escape hatch).
- [Debounce + priority interaction drops events] → High-frequency edits could starve low-priority schedule ticks. Mitigate: debounce dedupes by note id (not count), priority queue prevents starvation (schedule ticks enqueue at low priority but still drain), and vault-unlock flush enqueues a full delta scan so no note is permanently missed.
- [Cancellation after per-note transaction leaves partial batch] → Half the batch updated, half not. Accepted: per-note atomicity is the contract (also used by `indexing/persist.ts` and `semantic/persist.ts`); cancelled batch is still consistent, and next delta scan resumes.
- [Cron matcher drift vs system clock] → 60 s tick granularity may miss sub-minute cron expressions. Mitigate: document 1-minute minimum granularity; interval mode covers sub-minute needs.
- [Folder scope over large vaults blocks event loop] → Mitigate: paginated fetches with `setTimeout(0)` yields, same pattern as `indexing/pipeline.ts`; move scope resolution outside the runner's critical section so queueing is not blocked.
- [Settings validation for `echo.orchestrationSchedule`] → Malformed interval/cron should not crash scheduler. Mitigate: strict parser with `try/catch`, retain prior valid value, surface validation error via Joplin settings UI / log.

## Migration Plan

- **Deploy:** Ship `src/orchestration/**` and wire into `src/plugin/runtime.ts`: `onStart` opens DB → applies migrations → creates `Orchestrator` (runner + triggers + scheduler) → registers commands → starts watch + scheduler. `onStop` disposes listeners, clears timers, aborts in-progress run after current note, closes DB.
- **Backward compatibility:** Existing `indexing/scopes.ts` and `indexing/watch.ts` are either moved to `orchestration/scope.ts` / `orchestration/triggers.ts` or wrapped with re-exports so no external import breaks.
- **Rollback:** No DDL to revert. Rollback is removing `src/orchestration/` and restoring prior `watch.ts` wiring; `pipeline_runs` history remains readable. Notes in Joplin remain untouched; re-indexing from scratch is always possible via `DELETE FROM notes` cascade.
- **Data backfill:** None. Existing `pipeline_runs` rows remain; new runs use the runner's canonical logging.

## Open Questions

- None — pipeline selector `both` logging shape (one row vs two with `batchId`) is a small implementation choice that does not affect spec scenarios; pick one and document in `orchestrator.ts`.
- Whether `echo.orchestrationSchedule` should also support "on idle" triggers (Joplin idle detection) is deferred; it can be added as a new schedule value without changing the runner or scope contracts.
