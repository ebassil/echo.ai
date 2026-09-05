## Why

Configuration and pipeline control are scattered across settings, commands, and the CLI. Users need one panel to configure echo.ai, trigger and watch pipelines, and run searches without editing files.

## What Changes

- **Config panel** (webview): settings editor over the `echo.*` settings — LLM provider + models, retrieval toggles (per-retriever enable/disable, graph on/off), scheduling options, and a connection test.
- **Operations panel**: pipeline trigger buttons (structural/semantic, scope = note/folder/all), live progress and status, and run history from `pipeline_runs`.
- **Search UI**: run a retrieval query with the toggle set, view ranked results with source attribution, jump to notes.
- Wires the UI to `settings`, `orchestration`, and `retrieval` services.

## Capabilities

### New Capabilities
- `config-ui`: configuration + operations panel — settings editor, pipeline triggers and status, search UI

### Modified Capabilities
- None.

## Impact

- Consumes `settings`, `orchestration` (triggers/status/history), and `retrieval` (search results).
- Provides the in-app surface for everything `echo-cli` exposes externally.
- Depends on `echo-orchestration` (5) and `echo-retrieval` (7); the natural close of the sequence.