## Why

Indexing and semantic extraction need to run automatically (on note changes, on unlock, on a schedule) and be triggered manually. Without an orchestration layer, every caller re-implements queueing, scoping, and run bookkeeping.

## What Changes

- **Pipeline runner abstraction**: queue, priority, cancellation, progress reporting, and run logging to `pipeline_runs`.
- **Trigger framework**:
  - In-app commands (menu/toolbar actions).
  - Event triggers: note added/changed/deleted, vault unlock, app start.
  - Time-based scheduler (interval/cron-style) for periodic full or delta runs.
  - Manual trigger with scope.
- **Batch scope operations**: reindex a single note, a folder, or all notes — each runnable through structural and semantic pipelines together or separately.
- Status queries and run history exposed via an API for the CLI and UI to consume.

## Capabilities

### New Capabilities
- `orchestration`: pipeline runner, trigger framework (events, commands, schedule, manual), batch scope operations, run logging and status

### Modified Capabilities
- None.

## Impact

- Consumes `indexing`, `graph/semantic`, and `schema` (pipeline_runs, index_state).
- Consumed by `echo-cli` (external triggers), `echo-config-ui` (schedule config + trigger buttons), `echo-chat`/`echo-retrieval` (status checks).
- Scope semantics (note/folder/all) defined here become the single source of truth reused by CLI and UI.