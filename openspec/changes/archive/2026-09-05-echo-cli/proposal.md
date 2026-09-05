## Why

Scheduling and automation (cron, scripts, keybindings outside Joplin) need a way to trigger pipelines and run searches from the command line. The chosen mechanism is a localhost endpoint exposed by the plugin plus a matching CLI client.

## What Changes

- **Local HTTP endpoint** in the plugin process, bound to loopback only, guarded by a per-install token, exposing:
  - pipeline triggers (`run`, with scope: single note / folder / all, pipeline selection),
  - search (query + retrieval options),
  - status and run history.
- **`echo` CLI client**: a standalone binary with `echo pipeline run`, `echo search`, `echo status`, `echo update --note/--folder/--all`. It triggers the plugin over the endpoint when the app is running, and can read the plaintext index directly for offline search/status (shared schema package).
- Auth and transport hardening: loopback bind, token auth, no remote access; document the localhost-server pattern as a reviewed dual-use behavior.
- Spike confirmed: local endpoint + CLI client is the approach (vs Joplin CLI plugin support).

## Capabilities

### New Capabilities
- `cli`: localhost trigger/search API in the plugin plus the `echo` CLI client for scheduling and automation

### Modified Capabilities
- None.

## Impact

- Consumes `orchestration` (triggers, scope, status) and `schema` (direct index reads).
- The endpoint is the plugin's only listening surface; security posture is loopback + token auth, documented as a deliberate design choice.
- The CLI shares the schema/type package with the plugin to avoid drift.