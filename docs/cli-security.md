# echo.ai CLI endpoint — security posture (reviewed dual-use behavior)

echo.ai's Joplin plugin runs a **local HTTP server** so the `echo` CLI (and by
extension cron jobs, scripts, and keybindings outside Joplin) can trigger
pipelines, run searches, and read status. A localhost server inside a note
application is a **dual-use capability**: it is the mechanism that enables the
product's automation story, and it is also the kind of surface an attacker
would like to abuse. This document records the reviewed decision and the
boundary conditions that make it safe.

## Threat model

**Protected against:**

- **Remote access.** The server binds `127.0.0.1` only. There is no socket on
  any external interface; connections from other hosts are refused by the OS.
  A request whose socket peer is not a loopback address is rejected with
  `403` *before* any authentication check. `Host` header spoofing and
  `X-Forwarded-For` style headers are ignored — the source check uses the
  kernel-reported socket address, never request data.
- **Other local users.** Every route except `/v1/health` requires a
  `Bearer` token. The token is a per-install secret of 256 bits
  (`crypto.randomBytes(32)`), generated on first start, stored in the plugin
  data directory (`echo-token`, mode `0600` where supported), and never
  rotated automatically. The plugin UI exposes "Copy CLI token" and "Rotate
  CLI token" commands; the raw token is never written to logs or returned in
  responses (only an 8-char SHA-256 fingerprint is).
- **Brute force.** More than 5 failed authentications per minute from one
  source are answered with `429` and no further processing.
- **Note-content egress.** The endpoint can only ever return data that is
  already in the plaintext index (`chunks`, `pipeline_runs`). It never reads
  decrypted note bodies over the network. Pipeline triggers go through the
  orchestration vault gate: while the Joplin vault is locked, trigger
  requests are answered `202 deferred` and no decrypted content is read.
  Embeddings/LLM traffic still goes only to the user-configured local Ollama
  `baseUrl` per the LLM provider spec.

**Explicitly not protected against (accepted):**

- A process running as **the same user** already has read access to the
  plaintext index DB and the token file; the endpoint adds no new exposure
  for that attacker. This is consistent with the storage decision (Option A:
  plaintext index in the plugin data dir, trust boundary = OS user / disk
  encryption).
- The plugin data directory file `cli.json` also contains the token (for CLI
  convenience); it is restricted to `0600` where the filesystem supports it.
  On Windows ACLs are looser; the loopback-only bind remains the primary
  control.

## What the server exposes

| Route | Method | Purpose |
|---|---|---|
| `/v1/health` | GET | liveness probe; returns fingerprint only (no note data) |
| `/v1/pipeline/run` | POST | enqueue a manual pipeline run (scope: note/folder/all) |
| `/v1/search` | POST | FTS5/retrieval search over the index |
| `/v1/status` | GET | current run + queue snapshot |
| `/v1/runs` | GET | `pipeline_runs` history (filters + pagination) |
| `/v1/runs/:id` | GET | single run detail |

## Lifecycle

The server starts with the plugin (`onStart`, after the index DB opens) and
**stops when the plugin stops** — there is no standalone daemon. If the bind
fails the plugin logs a warning and continues; in-app commands are
unaffected. Port selection honors the `echo.cliPort` setting (default `0` =
ephemeral, persisted to `cli.json`); on port collision the server falls back
to an ephemeral port and rewrites the discovery file.

## CLI-side notes

- The `echo` CLI reads the token/port from the plugin data dir, or from
  `ECHO_TOKEN` / `ECHO_DATA_DIR` environment overrides.
- `--offline` opens the index SQLite file **read-only**; the CLI never holds
  write handles, so it cannot corrupt the plugin's index.
- Exit codes: `0` success, `1` user error, `2` transport/auth error.

## Review record

- Decision: localhost HTTP endpoint + CLI client was chosen over Joplin CLI
  plugin support (no desktop-plugin support) in the planning spike
  (see `openspec/changes/echo-cli/proposal.md` — "Why").
- Behavior is specified in `openspec/changes/echo-cli/specs/cli/spec.md`
  ("Authentication and transport hardening").
- If you extend the endpoint: keep the loopback guard before auth, keep
  responses limited to indexed data, and update this document.
