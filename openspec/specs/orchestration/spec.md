# orchestration Specification

## Purpose

Provides the orchestration layer that schedules, queues, scopes, and tracks every pipeline execution — the single coordination surface for structural indexing and semantic extraction that replaces ad-hoc trigger logic in callers.

## Requirements

### Requirement: Pipeline runner abstraction with queue, priority, and cancellation
The system SHALL provide a pipeline runner that queues pipeline executions, orders them by priority, supports cancellation of queued and in-progress runs, reports progress callbacks, and logs every run to `pipeline_runs`.

#### Scenario: Runner queues concurrent requests
- **WHEN** two pipeline runs are requested while a run is already in progress
- **THEN** the runner enqueues both requests in priority order and executes them sequentially (no parallel writes to the single SQLite connection)

#### Scenario: Priority ordering
- **WHEN** queued runs have different priorities (manual > event > schedule > startup)
- **THEN** the runner dequeues the highest-priority run first; runs at equal priority execute FIFO

#### Scenario: Cancel queued run
- **WHEN** a caller cancels a run that is still queued
- **THEN** the run is removed from the queue, a `pipeline_runs` row is written with `status='cancelled'`, and no pipeline work is performed for that run

#### Scenario: Cancel in-progress run
- **WHEN** a caller cancels the currently running pipeline execution
- **THEN** the runner signals cancellation to the pipeline, the pipeline stops after the current per-note transaction completes, and the `pipeline_runs` row is updated to `status='cancelled'` with `finished_at` set

#### Scenario: Progress reporting
- **WHEN** a pipeline run is in progress
- **THEN** registered progress callbacks receive `(processed, total, currentNoteId)` updates after each per-note transaction completes

#### Scenario: Run logging to pipeline_runs
- **WHEN** any pipeline run starts and finishes (success, failure, or cancellation)
- **THEN** a `pipeline_runs` row exists with `id`, `pipeline` (`structural` | `semantic` | `embedding` | `both`), `trigger` (`manual` | `event` | `schedule` | `startup`), `scope` (JSON encoding note/folder/all/cascade), `status` (`running` → `success` | `failed` | `cancelled`), `started_at`, `finished_at`, `notes_processed`, `chunks_created`, and `error` (truncated to 1k chars, null on success)

### Requirement: Trigger framework — in-app commands
The system SHALL expose Joplin commands (menu and toolbar actions) that trigger pipeline runs.

#### Scenario: Command triggers manual run
- **WHEN** the user invokes the "Echo: Reindex all" or "Echo: Extract semantics (all)" command via the Joplin command palette, menu, or toolbar
- **THEN** the system enqueues a manual pipeline run with the corresponding pipeline and scope, and surfaces run status via the runner's progress/logging

#### Scenario: Commands registered on startup
- **WHEN** the plugin starts
- **THEN** all orchestration commands are registered via `joplin.commands.register` and visible in the command palette

### Requirement: Trigger framework — event triggers
The system SHALL listen for Joplin note lifecycle events and vault state transitions and trigger debounced incremental pipeline runs, delegating watch behavior previously owned by `indexing/watch.ts`.

#### Scenario: Note added triggers structural reindex
- **WHEN** Joplin emits a note-added event for note N
- **THEN** the system debounces (coalescing rapid events, default window 1–2 seconds) and enqueues a scoped run for that single `noteId` through the runner (structural pipeline; semantic pipeline enqueued separately per cascade mode)

#### Scenario: Note changed triggers debounced reindex
- **WHEN** a note is edited
- **THEN** the system debounces and enqueues a single-note reindex for that `noteId`, matching the debounce semantics previously in `indexing/watch.ts`

#### Scenario: Note deleted triggers purge
- **WHEN** Joplin emits a delete event for a note
- **THEN** the system purges that note's index data (chunks, embeddings, structural edges, semantic evidence) via the same purge path as `indexing/delta.ts` and removes its `index_state` row

#### Scenario: Vault unlock triggers catch-up
- **WHEN** the vault transitions from locked to unlocked
- **THEN** the system enqueues a full delta scan (all-notes scope, hash-compare) to catch changes that occurred while locked, without requiring user action

#### Scenario: App start triggers delta scan
- **WHEN** the plugin starts with the vault unlocked
- **THEN** the system enqueues a full delta scan (all-notes, hash-compare) as a `startup`-trigger run; if the vault is locked at startup the scan is deferred until unlock

#### Scenario: Event loop suppression for enrichment writes
- **WHEN** structural enrichment writes to a note via `joplin.data.put`
- **THEN** the trigger framework suppresses enqueuing a reindex for that note id within the suppression window (e.g., 5 seconds), delegating to the same in-flight set mechanism as `semantic/enrichment.ts`

### Requirement: Trigger framework — time-based scheduler
The system SHALL provide a time-based scheduler that periodically enqueues pipeline runs on a configurable interval or cron-style schedule.

#### Scenario: Interval schedule enqueues periodic runs
- **WHEN** `echo.orchestrationSchedule` is set to an interval value (e.g., `every 30m`, `every 6h`)
- **THEN** the scheduler enqueues a full delta scan at that interval while the plugin is running, using `trigger='schedule'`

#### Scenario: Cron-style schedule
- **WHEN** `echo.orchestrationSchedule` is set to a cron expression (e.g., `0 */6 * * *`)
- **THEN** the scheduler enqueues a run at each matching wall-clock time while the plugin is running

#### Scenario: Scheduler disabled by default
- **WHEN** `echo.orchestrationSchedule` is unset or set to `off`/`disabled`
- **THEN** no periodic runs are enqueued; only event, command, and manual triggers are active

#### Scenario: Scheduler respects vault lock
- **WHEN** a scheduled tick fires while the vault is locked
- **THEN** the tick is deferred until unlock rather than reading decrypted content while locked

#### Scenario: Schedule change takes effect without restart
- **WHEN** the user changes `echo.orchestrationSchedule` via settings
- **THEN** the scheduler cancels the previous timer/cron and re-registers with the new schedule within the same plugin session

### Requirement: Trigger framework — manual trigger with scope
The system SHALL expose a programmatic manual trigger API that accepts a pipeline selector, scope, and options and enqueues a run through the runner.

#### Scenario: Manual trigger with note scope
- **WHEN** a caller invokes the manual trigger with `{ pipeline: 'structural', scope: { noteId: '<id>' } }`
- **THEN** only that note is processed (or reported as not found if the id does not exist)

#### Scenario: Manual trigger with folder scope
- **WHEN** a caller invokes the manual trigger with `{ pipeline: 'structural', scope: { folderId: '<id>' } }`
- **THEN** only notes whose `parent_id` equals that folder or its descendant folders are processed

#### Scenario: Manual trigger with all-notes scope
- **WHEN** a caller invokes the manual trigger with `{ pipeline: 'structural', scope: 'all' }`
- **THEN** every non-deleted Joplin note is considered for delta processing

#### Scenario: Pipeline selector controls which pipelines run
- **WHEN** the manual trigger is called with `pipeline='structural'`, `'semantic'`, or `'both'`
- **THEN** only the selected pipeline(s) execute; `both` runs structural followed by semantic sequentially within the same `pipeline_runs` batch or as two logged runs with a shared batch id

#### Scenario: Force option bypasses delta
- **WHEN** the manual trigger is called with `force=true`
- **THEN** matching notes are reprocessed regardless of content hash equality, for both structural and semantic pipelines

#### Scenario: Manual trigger returns run handle
- **WHEN** a manual trigger is enqueued
- **THEN** the caller receives a handle containing the `runId` (matching `pipeline_runs.id`) and a `cancel()` function

### Requirement: Batch scope operations
The system SHALL provide batch operations that reindex a single note, a folder (with descendants), or all notes through structural and semantic pipelines together or separately, reusing the scope semantics defined for manual triggers.

#### Scenario: Reindex single note through both pipelines
- **WHEN** the batch operation is invoked with `{ scope: { noteId: '<id>' }, pipelines: 'both' }`
- **THEN** structural indexing runs for that note followed by semantic extraction (with the configured cascade mode), each with per-note delta checks unless `force=true`

#### Scenario: Reindex folder through structural only
- **WHEN** the batch operation is invoked with `{ scope: { folderId: '<id>' }, pipelines: 'structural' }`
- **THEN** only structural indexing runs for notes in that folder subtree

#### Scenario: Reindex all through semantic only
- **WHEN** the batch operation is invoked with `{ scope: 'all', pipelines: 'semantic' }`
- **THEN** only semantic extraction runs over all notes

#### Scenario: Batch operation reports aggregated counts
- **WHEN** a batch operation completes
- **THEN** the caller receives aggregated counts of `notesProcessed`, `chunksCreated`, `entitiesCreated`, `relationsCreated`, `skipped`, and any per-note `errors`

#### Scenario: Batch operation delegates to runner
- **WHEN** a batch operation is invoked while another run is in progress
- **THEN** it is queued through the runner with priority `manual` and executes in priority order rather than running in parallel

### Requirement: Scope resolution as single source of truth
The system SHALL define scope resolution (note, folder with descendants, all) in one module that every caller (runner, CLI, UI, trigger framework) reuses.

#### Scenario: Single-note resolution
- **WHEN** scope `{ noteId: '<id>' }` is resolved
- **THEN** the resolver validates the note exists via `joplin.data` and returns exactly that id, or an error if not found

#### Scenario: Folder scope resolves descendants
- **WHEN** scope `{ folderId: '<id>' }` is resolved
- **THEN** the resolver walks the Joplin folder tree (BFS over `joplin.data.get(['folders'])` parent relations) to collect descendant folder ids and returns all note ids whose `parent_id` is in that set, with pagination handling for large vaults

#### Scenario: All-notes scope resolves via paginated fetch
- **WHEN** scope `'all'` is resolved
- **THEN** the resolver paginates `joplin.data.get(['notes'], { fields: [...], page: N, limit: 100 })` to collect all non-deleted note ids

#### Scenario: Scope resolver is the only implementation
- **WHEN** any caller needs to translate a scope into note ids
- **THEN** it imports the shared resolver rather than re-implementing folder-tree or pagination logic

### Requirement: Status queries and run history
The system SHALL expose status queries and run history for consumption by the CLI and UI.

#### Scenario: Current run status query
- **WHEN** a caller queries the current run status
- **THEN** the system returns the in-progress `pipeline_runs` row (if any) plus queue depth, queued run summaries (pipeline, trigger, scope, priority, enqueuedAt), and the latest progress callback values

#### Scenario: Run history query
- **WHEN** a caller queries run history with optional filters (`pipeline`, `status`, `limit`, `offset`)
- **THEN** the system returns `pipeline_runs` rows ordered by `started_at` DESC, filtered and paginated per the query, supported by the existing index on `pipeline_runs(pipeline, started_at)`

#### Scenario: Run detail query
- **WHEN** a caller queries a specific run by `id`
- **THEN** the system returns the full `pipeline_runs` row or a not-found error if the id does not exist

#### Scenario: Status API is read-only and local
- **WHEN** status or history is queried
- **THEN** no Joplin note content is read and no network call is made; only the local SQLite `pipeline_runs` table is accessed

### Requirement: Vault lock gates all pipeline execution
The system SHALL gate all pipeline execution behind the vault-unlock state: no decrypted note content is read while the Joplin vault is locked, and deferred runs are flushed on unlock.

#### Scenario: No execution while locked
- **WHEN** any trigger (event, schedule, manual, startup) requests a pipeline run while the vault is locked
- **THEN** the request is queued/deferred and no `joplin.data.get` that would read decrypted content is issued until unlock

#### Scenario: Flush on unlock
- **WHEN** the vault transitions from locked to unlocked
- **THEN** all deferred runs are enqueued through the runner in priority order and a full delta scan is enqueued if any note changed while locked

#### Scenario: In-progress run interrupted by lock
- **WHEN** the vault becomes locked while a run is in progress
- **THEN** the runner signals cancellation for the current run after the current per-note transaction completes, and remaining queued notes are deferred until unlock

### Requirement: Settings for orchestration
The system SHALL register orchestration settings keys for schedule configuration and expose them via the `echo.*` settings surface.

#### Scenario: Schedule setting registered
- **WHEN** the plugin starts
- **THEN** a setting `echo.orchestrationSchedule` is registered (default `off`/`disabled`) accepting values `off`, interval strings (e.g., `30m`, `6h`), or cron expressions, with validation rejecting malformed values

#### Scenario: Schedule setting validation
- **WHEN** the user sets `echo.orchestrationSchedule` to an invalid value
- **THEN** the plugin reports the invalid value and retains the previous valid setting

### Requirement: Plaintext index and local-first security posture
The system SHALL keep all orchestration state (queue, run history, schedule config) local, SHALL NOT sync orchestration data, and SHALL NOT send note content to any remote endpoint as part of orchestration.

#### Scenario: Orchestration state is local and unsynced
- **WHEN** the runner or scheduler persists state (pipeline_runs, queued scopes)
- **THEN** it resides only in the plugin data directory SQLite file (per storage spec) and is never placed in a Joplin sync folder

#### Scenario: No network exfiltration during orchestration
- **WHEN** orchestration queues, schedules, or reports status
- **THEN** no note content is sent to any network endpoint; only downstream pipeline steps (embeddings, extraction) may contact the configured local Ollama `baseUrl` per their own specs
