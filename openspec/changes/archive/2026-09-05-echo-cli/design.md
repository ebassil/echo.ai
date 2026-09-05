## Context

See `proposal.md` — Why for motivation and `specs/cli/spec.md` for normative requirements.

Current state:
- Joplin desktop plugin (Electron, TypeScript + Webpack). Plugins run in a BrowserWindow with Node `http`/`net` available, `fetch` available, SQLite via `joplin.require('sqlite3')`. No sidecar process model exists.
- `echo-orchestration` (change 5) lands `src/orchestration/` — `runner.ts` (serial queue, priority, cancellation, `pipeline_runs` logging), `scope.ts` (single source of truth for note/folder/all resolution), `status.ts` (read-only status/history queries), `scheduler.ts`, and `triggers.ts`. No HTTP surface exists yet.
- `echo-schema` (archived) provides the full DDL (`notes`, `chunks`, `chunks_fts`, `embeddings`, `nodes`, `edges` with `layer`, `entities`, `relations`, `index_state`, `pipeline_runs`) in the plugin data dir plaintext SQLite DB. `retrieval` (change 7) and `chat`/`graph-view`/`config-ui` are downstream consumers.
- Spike in proposal: local loopback endpoint + CLI client is the confirmed approach (vs Joplin CLI plugin support, which does not exist for desktop plugins). No prior localhost server in the plugin.

Constraints that shape the approach:
- Prefer pure-JS deps; native modules hard to bundle with Webpack into the Joplin plugin.
- Single SQLite writer (see `echo-foundation` design — one shared connection). The HTTP handlers must not open a second writer; they enqueue through the runner or do read-only queries.
- Plugin `onStart`/`onStop` owns lifecycle — the HTTP server must be started there and torn down there. Joplin does not provide a "background service" primitive.
- Security posture: plaintext index on disk, E2EE notes decrypted at runtime while vault is unlocked, local-first, no note content leaves the machine except to the configured local Ollama `baseUrl`. The new listening surface must be reviewed as a dual-use loopback server.

## Goals / Non-Goals

**Goals:**
- A loopback-only HTTP trigger/search/status API inside the plugin process, guarded by a per-install bearer token, that reuses `orchestration/runner`, `orchestration/scope`, and `orchestration/status` without duplicating scope or queue logic.
- A standalone `echo` CLI (`echo pipeline run`, `echo search`, `echo status`, `echo update --note/--folder/--all`) that talks to the endpoint when the app is running and can read the plaintext SQLite index directly (same schema package) for offline search/status.
- Token+port discovery via the plugin data dir (with `ECHO_DATA_DIR`/`ECHO_TOKEN` overrides), documented loopback+token threat model, and clean exit codes + help.

**Non-Goals:**
- Retrieval implementation itself (BM25/FTS5, dense kNN, RRF, TF-IDF, fuzzy, graph) — owned by `echo-retrieval`; this change only wires search through retrieval when present and falls back to FTS5-only for offline.
- New DDL or a separate CLI-owned database — the index DB remains single-writer, owned by the plugin; CLI offline reads are read-only over the same file.
- Remote management, TLS termination, or multi-user auth — the threat model explicitly rejects remote access.
- A Joplin CLI plugin or `joplin` binary integration — desktop plugins cannot run inside the Joplin CLI per spike.
- Webview/panel UI — `echo-config-ui` provides the in-app surface; CLI is the headless surface.

## Decisions

### HTTP server: Node `http.createServer` inside `plugin/runtime.ts`
Create a tiny `src/cli/server.ts` exposing `startCliServer(dataDir, deps)` / `stopCliServer()` called from `plugin/runtime.ts` `onStart`/`onStop`. It binds `127.0.0.1` on a persisted port (default: pick ephemeral on first start, write to `cli.json` in the data dir; override via `echo.cliPort` setting), enforces loopback source check on every request before auth, and validates `Authorization: Bearer <token>` against the persisted token. Route table: `POST /v1/pipeline/run`, `POST /v1/search`, `GET /v1/status`, `GET /v1/runs`, `GET /v1/runs/:id`, plus `GET /v1/health`.

- **Why:** Node `http` is available in the plugin BrowserWindow with no extra dep, smallest surface for a loopback-only JSON API. Tying lifecycle to `runtime.ts` matches every other service owned there. Persisted `cli.json` gives CLI discovery without a registry daemon.
- **Alternative:** Express/Fastify — heavier, no routing benefit at 6 endpoints. Rejected.
- **Alternative:** Bind `0.0.0.0` with auth — violates loopback-only requirement and expands threat model unnecessarily. Rejected.
- **Alternative:** Ephemeral port every restart without persistence — CLI would need to scan ports or require env var every invocation; usability loss. Rejected.

### Token generation, storage, and permissions
On first start if `token` file missing, generate 32 bytes via `crypto.randomBytes` (64 hex chars, >128 bits), write to `<dataDir>/echo-token` with mode `0o600` where supported (best-effort on Windows), also write `{ port, tokenFingerprint }` to `<dataDir>/cli.json` (raw token only in `echo-token`/`cli.json` secret field). Provide a "Rotate token" command that regenerates and rewrites. CLI resolves token as `ECHO_TOKEN` env var > `cli.json`/`echo-token` file. Fingerprint in logs is `sha256(token).slice(0,8)`.

- **Why:** Per-install secret with no user-supplied password gives automation without credential management friction; restrictive permissions + loopback-only is the standard Electron app pattern (like VS Code server `token` pattern). Rejected alternative: settings-stored token — Joplin settings are readable by any plugin and synced in some configs; a file in the data dir is more isolated.
- **Alternative:** No auth, loopback only — insufficient on multi-user machines where another local user can hit `127.0.0.1`; per-install token is cheap defense-in-depth. Rejected.

### Request handling delegates to orchestration (no new queue)
- `POST /v1/pipeline/run` parses JSON, validates `pipeline` ∈ `structural|semantic|both|embedding` and `scope` shape, calls `resolveScope(scope)` from `orchestration/scope` (single source of truth), then `enqueueRun({ pipeline, scope, trigger:'manual', force, cascade })` from `orchestration/runner`. Vault-locked fast-path checks `isVaultLocked()` and returns `202 { status:'deferred' }` without reading decrypted content.
- `POST /v1/search` and `GET /v1/status|runs` delegate to `retrieval` (when present) or to `orchestration/status` read-only queries. No `joplin.data.get` of note bodies inside handlers except via `resolveScope` existence checks.

- **Why:** Prevents queue/scope drift — CLI and config-ui both go through the same runner. Keeping handlers thin makes the server testable with fake runner/status.
- **Alternative:** Handlers replicate scope resolution inline — duplicates folder-tree BFS and pagination logic, already rejected in `echo-orchestration` design. Rejected.

### Route validation and error mapping
Use a hand-rolled JSON body parser (`rawBody` ≤ 64 KB, `JSON.parse` + shape check) and explicit HTTP codes: 400 shape/query validation, 401 missing/invalid token, 403 non-loopback, 404 unknown ids, 413 body too large, 503 vault-locked where relevant. Rate-limit token failures (e.g., 5/min per socket) with 429 to blunt brute force on a local port.

- **Why:** No framework needed; hand-rolled validation keeps dep count zero and failure modes explicit. Separate 401 vs 403 prevents token oracle while preserving auditability.
- **Alternative:** Schema validator like `zod` — nice but adds dep and still needs HTTP mapping; can be added later without changing spec. Rejected for now.

### CLI distribution: `cli/` package with Node binary + shared schema package
New directory `cli/` at repo root (outside `src/` build that Webpack bundles for the plugin) with its own `package.json` (`name: echo-cli`, `bin: { echo: "./dist/cli.js" }`), TypeScript + `commander` (or `yargs`) for arg parsing, `node-fetch` not needed (Node 18+ has global `fetch`). Shared schema import: extract `src/schema/` and `src/storage/migrations` row-type exports into `packages/schema/` (or `src/schema/index.ts` re-exported for both builds) so CLI and plugin import from `@echo.ai/schema` rather than relative paths into each other's build. This is the only structural sharing change; no runtime coupling.

Build: `npm --prefix cli run build` outputs `cli/dist/cli.js` with shebang `#!/usr/bin/env node`; `npm link` / `npm pack` / `npx` install works. Tests can invoke the built binary via `node cli/dist/cli.js`.

Commands (Commander hierarchy):
```
echo pipeline run --note <id> --pipeline both --force
echo pipeline run --folder <id> ...
echo pipeline run --all ...
echo update --note/--folder/--all        (alias for pipeline run)
echo search "query" --limit 10 --offline --retriever bm25,dense
echo status [--history --limit 20] [--run <id>] [--offline]
echo --help / --version
```
Exit codes: 0 success, 1 user error, 2 transport/auth.

- **Why:** Separating `cli/` from the Webpack-bundled `src/` avoids bundling Node `http`/CLI deps into the Joplin plugin jsz. `commander` is pure-JS, small, and fits the "prefer pure-JS" constraint. Sharing schema via a tiny package prevents drift when `chunks_fts` or `pipeline_runs` columns change (approach 3 from `echo-foundation` design).
- **Alternative:** Bundle CLI into `src/cli/` and reuse the plugin Webpack config — would bundle `commander` into the plugin artifact and pull Node `http` into the CLI. Rejected.
- **Alternative:** Go/Rust CLI binary — faster startup but adds toolchain and duplicates schema types; Node keeps types shared. Rejected.
- **Alternative:** CLI shells out to `joplin` CLI — Joplin CLI is a separate app with different profile paths; not applicable to desktop plugin automation. Rejected (per spike).

### Offline direct-index reads (read-only SQLite)
When `echo search --offline` or `echo status --offline` or when the endpoint is unreachable and config opts into offline, the CLI opens the SQLite file directly at `<dataDir>/index.db` (path discovered via `ECHO_DATA_DIR` or Joplin profile heuristic) with `sqlite3` `OPEN_READONLY` (or `better-sqlite3` read-only if we accept the native dep only in `cli/`). It runs FTS5 `SELECT ... FROM chunks_fts WHERE chunks_fts MATCH ?` plus `pipeline_runs` selects using the same SQL as `storage/db` helpers imported from the shared schema package. Write handles are never opened by the CLI.

- **Why:** Enables cron/scripts that run even when Joplin is not open, without requiring a daemon. Read-only open prevents CLI/plugin writer contention.
- **Alternative:** Require plugin to be running for all reads — fails the offline use case in the proposal (scheduling when app is closed still wants status/search). Rejected.
- **Alternative:** Duplicate the DB for offline — drift and storage cost. Rejected.
- **Trade-off:** If CLI uses `sqlite3` (JS wrapper over native `sqlite3`), `cli/` must tolerate native install; acceptable because `cli/` is not Webpack-bundled and `npm install` in `cli/` can build the native module. If native is undesirable, use `sqlite` WASM or `node:sqlite` (Node 22+ experimental) later without changing the spec.

### Port discovery and profile path heuristic
CLI resolves data dir as: `ECHO_DATA_DIR` env var > `joplin` profile heuristic (`~/.config/joplin-desktop` or platform-specific `app.getPath('userData')` sibling) > `<dataDir>/cli.json` `port` field when endpoint is up (read from filesystem). This matches the pattern `joplin` plugins use for profile paths and avoids requiring the user to configure a port.

- **Why:** Zero-config for the common case where Joplin uses its default profile; `ECHO_DATA_DIR` override covers custom profiles and tests. Reading `cli.json` means the ephemeral-port case still works.
- **Alternative:** Require `--port`/`--token` flags always — ergonomic loss. Rejected.

### Security documentation and review surface
Add a short `docs/cli-security.md` (and a note in `settings` UI + README) stating: loopback-only, token auth, no remote exposure, plaintext index, no decrypted note egress over the endpoint, and that the server stops with the plugin. Tag the change for security review and note the reviewed dual-use decision.

- **Why:** The config explicitly says to "document the localhost-server pattern as a reviewed dual-use behavior." Making it a first-class doc artifact ensures reviewers can find it.
- **Alternative:** Only a code comment — not discoverable. Rejected.

## Risks / Trade-offs

- [New localhost listener expands attack surface] → Bind `127.0.0.1` only, per-install token, no CORS, no remote headers, 401/403 separation, rate-limit brute force, document as reviewed dual-use, commands surface fingerprint not raw token.
- [CLI and plugin schema drift] → Share row types/DDL via `packages/schema` (or `src/schema` re-export) so `chunks_fts`/`pipeline_runs` changes fail the build if CLI not updated. Validate with a `cli` integration test that imports the shared types.
- [Plugin is BrowserWindow — `http` server competes with Electron event loop] → Keep handlers synchronous-thin and delegate to `runner`/`status` which do the real work on the same event loop; no per-request DB writer contention (read-only or enqueue only).
- [Offline read races with plugin writer (`SQLITE_BUSY`)] → CLI opens read-only and runs short SELECTs; plugin holds single writer. On `SQLITE_BUSY`, CLI retries once after 50 ms and reports a clear message. No CLI-side migrations ever.
- [Port collision on ephemeral choice] → If `EADDRINUSE` on start, pick next free port and rewrite `cli.json`; CLI always reads the file, so no stale port.
- [Native `sqlite3` in `cli/` hurts install] → Accept for `cli/` (not plugin); fallback plan is WASM/`node:sqlite` if native proves painful. Plugin itself stays `joplin.require('sqlite3')` (already provided).
- [Profile path heuristic wrong on custom installs] → `ECHO_DATA_DIR` override + clear error message with expected path; document in `echo --help`.
- [Reading `echo-token` file permissions on Windows] → Best-effort `chmod 0o600`; on Windows ACLs are looser but loopback+token still applies, and token file is inside the user's profile dir.

## Migration Plan

- **Deploy:** Ship `src/cli/server.ts`, wire `startCliServer`/`stopCliServer` into `src/plugin/runtime.ts` `onStart`/`onStop` (after DB open, before triggers). Add `cli/` package, `packages/schema/` extraction (or `src/schema` re-export) without changing published plugin artifact. Register "Copy CLI token" / "Show endpoint status" commands.
- **Token/port file:** On first run, create `<dataDir>/echo-token` and `<dataDir>/cli.json`. Existing installs without them get created on next start; old `cli.json` with different shape is migrated in place.
- **Build:** Plugin continues `webpack --env joplin-plugin-config=buildMain` (ignores `cli/`). CLI builds with `tsc -p cli/tsconfig.json` (or `tsup`). `npm run dist` still produces the Joplin `jpl`; `cli` publish is separate (`npm pack` or `npm publish` under `echo-cli`).
- **Rollback:** Remove `src/cli/server.ts` wiring and delete `<dataDir>/cli.json`/`echo-token` if desired; `pipeline_runs` history remains. CLI binary can be uninstalled with `npm unlink`. No DDL to revert.
- **Backward compatibility:** No API version bump. The endpoint is additive; `echo-orchestration`'s `manual` trigger via Joplin commands continues to work even if the HTTP server fails to start (log warning, do not crash plugin).
- **Data backfill:** None.

## Open Questions

- Whether `echo search` should also expose TF-IDF/fuzzy/dense toggles individually or via a single `--retrievers` CSV flag is a CLI ergonomics choice that does not change the endpoint shape; pick one and document in `cli --help`.
- Exact Joplin profile path heuristic across platforms (Linux `~/.config/joplin-desktop`, macOS `~/Library/Application Support/Joplin`, Windows `%APPDATA%/Joplin`) — defer to implementation, covered by `ECHO_DATA_DIR` escape hatch.
- Whether `cli/` should use `better-sqlite3` (sync, faster) vs `sqlite3` (async, Joplin-compatible) for offline reads — defer to implementation; spec only requires read-only correctness.
