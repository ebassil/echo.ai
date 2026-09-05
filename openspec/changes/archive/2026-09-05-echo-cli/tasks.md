## 1. Shared schema package and scaffolding

- [x] 1.1 Extract shared schema types/DDL helpers into `packages/schema` (or `src/schema/index.ts` re-export) so both plugin and CLI import row types and table constants from `@echo.ai/schema` rather than duplicating DDL, and verify the plugin build still passes.
- [x] 1.2 Create `cli/` package scaffold (`cli/package.json`, `cli/tsconfig.json`, `cli/src/`, `cli/dist` gitignore, `bin: { echo: "./dist/cli.js" }` with shebang handling) that is excluded from the Joplin Webpack build.
- [x] 1.3 Add `cli` build script (`tsc -p cli/tsconfig.json` or `tsup`) and `npm --prefix cli` wiring so `npm run build` in repo root does not bundle `cli/`, and verify `node cli/dist/cli.js --help` prints after build.

## 2. Loopback HTTP endpoint in plugin process

- [x] 2.1 Implement `src/cli/server.ts` with `startCliServer(dataDir, deps)` / `stopCliServer()` using Node `http.createServer`, loopback-source guard (`remoteAddress` ∈ `127.0.0.1/8`, `::1`/`::ffff:127.0.0.1`) before auth, 64 KB body cap, and route table (`POST /v1/pipeline/run`, `POST /v1/search`, `GET /v1/status`, `GET /v1/runs`, `GET /v1/runs/:id`, `GET /v1/health`).
- [x] 2.2 Implement per-install token generation (`crypto.randomBytes` 32 bytes → 64 hex chars) and persistence to `<dataDir>/echo-token` (+ `<dataDir>/cli.json` with `{ port, tokenFingerprint }`), restrictive permissions where supported, and `ECHO_TOKEN` env var override read path; add `sha256(token).slice(0,8)` fingerprint helper for logs.
- [x] 2.3 Wire token/port lifecycle to `src/plugin/runtime.ts` `onStart`/`onStop` (start after `openDatabase`, stop before `closeDatabase`), handle `EADDRINUSE` by picking next free port and rewriting `cli.json`, and log bound address with fingerprint only (never raw token).
- [x] 2.4 Register Joplin commands ("Echo: Show endpoint status", "Echo: Copy CLI token / Rotate token") that surface bound port, token fingerprint, and current run without exposing the raw token, and handle the vault-locked vs unlocked display.

## 3. Pipeline trigger endpoint

- [x] 3.1 Implement `POST /v1/pipeline/run` validation (`pipeline` ∈ `structural|semantic|both|embedding`, `scope` shape `{ noteId } | { folderId } | "all"`, optional `force`, `cascade`) with 400/404 error mapping and `resolveScope(scope)` via `orchestration/scope` (single source of truth, no inline folder-tree logic).
- [x] 3.2 Enqueue via `orchestration/runner` `enqueueRun({ pipeline, scope, trigger:'manual', force })`, respect `isVaultLocked()` gate (return 202 `{ status:'deferred', runId }` without reading decrypted content while locked), and return 202 `{ runId, pipeline, scope, trigger:'manual' }` on success.
- [x] 3.3 Add rate limiting for 401/403 responses (e.g., 5 failures/min per socket → 429) and ensure 401 bodies do not leak token existence.

## 4. Search endpoint and status/history endpoints

- [x] 4.1 Implement `POST /v1/search` validation (non-empty query, max length, `limit`, `retrievers` toggles) and delegation to retrieval (`RRF` fused results) when `echo-retrieval` is present, falling back to FTS5-only `chunks_fts MATCH` for the CLI-offline-parity path; map 400/200 and ensure no `joplin.data.get` of note bodies beyond the index.
- [x] 4.2 Implement `GET /v1/status` as read-only `orchestration/status.getCurrentStatus()` (currentRun, queueDepth, queuedRuns, progress) with no note-content reads.
- [x] 4.3 Implement `GET /v1/runs` with filter parsing (`pipeline`, `status`, `limit`/`offset`) and `GET /v1/runs/:id` using the `pipeline_runs(pipeline, started_at)` index, with 400 for invalid filters and 404 for unknown ids.

## 5. CLI client — commands, auth, and transport

- [x] 5.1 Implement CLI arg parsing (`commander` or `yargs` — pure-JS) for `echo pipeline run [--note <id> | --folder <id> | --all] [--pipeline structural|semantic|both] [--force]`, printing runId/status URL and mapping to the HTTP payload.
- [x] 5.2 Implement `echo update --note/--folder/--all` as an alias for `pipeline run` with identical flags and output.
- [x] 5.3 Implement `echo search "<query>" [--limit N] [--retrievers bm25,dense,... | --no-graph] [--offline] [--json]` that sends `POST /v1/search` when online (authenticated via `ECHO_TOKEN` or `<dataDir>/cli.json` token) and prints ranked attributed results.
- [x] 5.4 Implement `echo status [--history --limit N] [--run <id>] [--offline] [--json]` that calls `GET /v1/status|runs` when online and prints current run / queue / history.
- [x] 5.5 Implement token/port discovery (`ECHO_DATA_DIR` env var > Joplin profile heuristic > `cli.json`), `ECHO_TOKEN` precedence, and transport error handling with exit codes (0 success, 1 user error, 2 transport/auth with message to stderr and missing-file diagnostics).
- [x] 5.6 Implement `--help`/`--version` (semver matching plugin release) for every command without requiring the plugin to be running.

## 6. Offline direct-index fallback

- [x] 6.1 Implement CLI read-only SQLite open of `<dataDir>/index.db` (via `sqlite3` `OPEN_READONLY` or `better-sqlite3` read-only, confined to `cli/` so plugin stays `joplin.require('sqlite3')`) using the shared schema package for SQL, with `SQLITE_BUSY` retry-once and clear error message.
- [x] 6.2 Implement offline `search` path (`SELECT ... FROM chunks_fts WHERE chunks_fts MATCH ?` + note metadata join) and offline `status`/`history` path (`SELECT * FROM pipeline_runs ... ORDER BY started_at DESC`) that print the same shape as the online endpoint without requiring the plugin to be running.
- [x] 6.3 Verify offline reads are read-only (no `INSERT`/`UPDATE`/`DELETE`/`CREATE` code paths in `cli/`), and that a CLI build fails if the shared schema import is missing (drift guard).

## 7. Security hardening, docs, and tests

- [x] 7.1 Enforce loopback-only bind verification (`netstat`-style assertion in test: remote connect to external IP refused; `Host`/`X-Forwarded-For` spoofing returns 403), bearer-token auth on every non-`health` route, and token-never-logged invariant (only fingerprint).
- [x] 7.2 Document the localhost-server pattern as a reviewed dual-use behavior in `docs/cli-security.md` (and README/security note + settings UI note): loopback-only, token auth, plaintext index boundary, stops with plugin, no decrypted note egress over the endpoint.
- [x] 7.3 Add endpoint tests (plugin-side): loopback guard, 401/403/400/404 mapping, vault-locked deferred return, `resolveScope` delegation, rate-limit, start/stop lifecycle, `EADDRINUSE` handling, fingerprint logging.
- [x] 7.4 Add CLI tests: `pipeline run`/`update`/`search`/`status` arg parsing and HTTP mapping, `ECHO_TOKEN`/`ECHO_DATA_DIR` discovery, offline `search`/`status` vs known DB fixture, exit codes (0/1/2), `--help`/`--version` without running plugin, shared-schema import drift check.
- [x] 7.5 Run `openspec validate --change echo-cli --strict` and address any proposal/spec/design/task mismatches before handoff to `echo-retrieval` consumers.
