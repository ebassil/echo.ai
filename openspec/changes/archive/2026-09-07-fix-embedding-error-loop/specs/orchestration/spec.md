## MODIFIED Requirements

### Requirement: Trigger framework — event triggers
The system SHALL listen for Joplin note lifecycle events and vault state transitions and trigger debounced incremental pipeline runs through the runner, delegating watch behavior previously owned by `indexing/watch.ts`. This framework is the single owner of Joplin event watching: no legacy watcher runs in parallel.

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

#### Scenario: Single trigger owner
- **WHEN** the plugin starts
- **THEN** exactly one event-listener registration path is active (the orchestration trigger framework) and the legacy `indexing/watch.ts` watcher is not started, so a single Joplin note event enqueues at most one scoped run

## ADDED Requirements

### Requirement: Automatic runs defer when the provider is unreachable
The system SHALL gate automatic pipeline runs (event, schedule, startup triggers) behind the provider health gate so an unreachable LLM provider aborts the run up front with one consolidated status instead of issuing failed requests per note.

#### Scenario: Automatic run aborts early on provider-down
- **WHEN** an automatic trigger starts a pipeline run and the provider health gate reports the provider `down`
- **THEN** the run is aborted up front with a single "provider unreachable — indexing deferred" status and no per-note index mutations are performed

#### Scenario: Schedule and event runs skip while down
- **WHEN** the provider is `down` and an event or schedule tick fires
- **THEN** the run is deferred (not re-queued in a loop) and waits for a later automatic run once the gate reports the provider `up`

#### Scenario: Manual run still executes
- **WHEN** a manual trigger starts a run while the provider is `down`
- **THEN** the run executes structural-only work and defers embedding per the provider-health specification instead of aborting