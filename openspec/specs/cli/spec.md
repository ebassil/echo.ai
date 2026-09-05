# CLI Specification

## Purpose

Provides the loopback-only HTTP trigger/search API hosted inside the Joplin plugin process and the standalone `echo` CLI client that drives pipelines, search, and status for scheduling, scripting, and keybinding automation.

## Requirements

### Requirement: Loopback HTTP endpoint lifecycle
The system SHALL host an HTTP endpoint inside the Joplin desktop plugin process that binds exclusively to the loopback interface, starts when the plugin starts, stops when the plugin stops, and persists a per-install bearer token and bound port for CLI discovery.

#### Scenario: Endpoint binds to loopback on startup
- **WHEN** the plugin starts with the vault in any state
- **THEN** the system binds an HTTP server to `127.0.0.1` on a per-install port (default ephemeral with persisted assignment or `echo.cliPort` setting), writes the port and token to a file in the plugin data dir, and logs the bound address without exposing it outside the host

#### Scenario: Endpoint stops on plugin shutdown
- **WHEN** Joplin stops the plugin (`onStop`)
- **THEN** the system closes the HTTP server, releases the port, and rejects any in-flight requests with connection close, without leaving a listening socket

#### Scenario: Per-install token generation and persistence
- **WHEN** no token file exists on first startup
- **THEN** the system generates a cryptographically random token (at least 128 bits, e.g., 32 hex chars), persists it with restrictive file permissions to the plugin data dir, and reuses that token on subsequent starts until manually rotated

#### Scenario: CLI discovers port and token via plugin data dir
- **WHEN** the CLI needs to contact the plugin
- **THEN** it reads the port/token file from the plugin data directory path (resolved via Joplin profile path or `ECHO_DATA_DIR` override) and uses those values for the request; if the file is missing the CLI reports that the plugin is not running

### Requirement: Authentication and transport hardening
The system SHALL enforce that the endpoint is reachable only via loopback and only with a valid per-install bearer token, SHALL reject all other transport, and SHALL document the localhost-server pattern as a deliberately reviewed dual-use behavior.

#### Scenario: Valid token over loopback succeeds
- **WHEN** a request arrives from `127.0.0.1` or `::1` with header `Authorization: Bearer <per-install-token>`
- **THEN** the system processes the request normally

#### Scenario: Missing or invalid token is rejected
- **WHEN** a request arrives without an `Authorization` header or with an incorrect token
- **THEN** the system responds with HTTP 401, does not execute any pipeline or search logic, and does not leak whether the token file exists

#### Scenario: Non-loopback source is rejected
- **WHEN** a request arrives with a remote address outside `127.0.0.1/8` and `::1` (including via Host header spoofing or forwarded headers)
- **THEN** the system responds with HTTP 403 and does not process the request, regardless of token validity

#### Scenario: No remote listening surface
- **WHEN** the HTTP server is inspected via `netstat`/`ss` or a remote host attempts to connect to the plugin host's external IP on the bound port
- **THEN** no socket is reachable outside loopback and the connection is refused

#### Scenario: Token never logged or returned
- **WHEN** authentication fails or status/history is queried
- **THEN** the response and plugin logs do not include the token value, only a truncated fingerprint for diagnostics

### Requirement: Pipeline trigger endpoint
The system SHALL expose a pipeline trigger endpoint that enqueues runs through the orchestration runner with pipeline selector, scope, and force semantics, and returns a run handle that the CLI surfaces.

#### Scenario: Trigger single note via HTTP
- **WHEN** a client POSTs to `POST /v1/pipeline/run` with JSON `{ pipeline: 'structural', scope: { noteId: '<id>' } }` and a valid token
- **THEN** the system validates the note exists via the shared scope resolver, enqueues a `manual` run through `orchestration/runner`, and responds with HTTP 202 and body `{ runId, pipeline, scope, trigger: 'manual' }`; an unknown noteId yields HTTP 404

#### Scenario: Trigger folder scope via HTTP
- **WHEN** a client POSTs with `{ pipeline: 'both', scope: { folderId: '<id>' } }`
- **THEN** the system resolves the folder subtree via the shared scope resolver, enqueues the run, and returns 202; an unknown folderId yields HTTP 404

#### Scenario: Trigger all-notes scope via HTTP
- **WHEN** a client POSTs with `{ pipeline: 'semantic', scope: 'all' }`
- **THEN** the system enqueues an all-notes manual run and returns 202 with the runId

#### Scenario: Pipeline selector and force option
- **WHEN** a client POSTs with `pipeline` in `structural | semantic | both | embedding` and optional `force: true`
- **THEN** only the selected pipeline(s) execute (`both` runs structural then semantic sequentially) and `force=true` bypasses content-hash delta checks; an invalid pipeline value yields HTTP 400

#### Scenario: Vault locked defers trigger
- **WHEN** a pipeline trigger is received while the vault is locked
- **THEN** the system does not read decrypted note content, enqueues the request as deferred via the orchestration vault gate, and returns 202 with status `deferred` and the runId; the run executes after unlock

#### Scenario: CLI pipeline command maps to endpoint
- **WHEN** the user runs `echo pipeline run --note <id>` or `echo pipeline run --folder <id>` or `echo pipeline run --all` with flags `--pipeline structural|semantic|both` and `--force`
- **THEN** the CLI translates the flags into the HTTP trigger payload, sends the authenticated POST, and prints the returned runId and a status URL

### Requirement: Search endpoint
The system SHALL expose a search endpoint that runs the retrieval pipeline over the local index with query and retriever options and returns ranked, attributed results; the CLI SHALL support offline search by reading the plaintext SQLite index directly via the shared schema package when the plugin is not running.

#### Scenario: Search via HTTP when plugin is running
- **WHEN** a client POSTs to `POST /v1/search` with `{ query: 'hello', limit: 10, retrievers: { bm25: true, dense: true, graph: false } }` and a valid token
- **THEN** the system runs retrieval (BM25/FTS5, dense kNN, etc., per enabled toggles fused by RRF) over the index, truncates to `limit`, and returns HTTP 200 with `{ results: [{ chunkId, noteId, title, snippet, score, source }], query, total }` without reading Joplin note content beyond the indexed chunks

#### Scenario: Search validates query
- **WHEN** a client sends an empty query or a query exceeding the configured max length
- **THEN** the system responds with HTTP 400 and does not execute retrieval

#### Scenario: CLI search command online path
- **WHEN** the user runs `echo search "hello world" --limit 5 --no-graph`
- **THEN** the CLI sends the authenticated search request if the endpoint is reachable and prints ranked results with note titles and chunk snippets

#### Scenario: CLI search offline direct-index fallback
- **WHEN** the user runs `echo search "hello" --offline` or the endpoint is unreachable and `--offline` is implied by config
- **THEN** the CLI opens the plaintext SQLite DB in the plugin data dir directly (read-only, via the shared schema package), executes the same FTS5/BM25 path, and prints results without requiring the plugin to be running; if the DB is locked for writing the CLI retries once and reports the lock

#### Scenario: Search does not leak decrypted content beyond index
- **WHEN** search runs via HTTP or offline
- **THEN** only indexed chunk content and note metadata already in the index are returned; no live `joplin.data.get` fetch of decrypted notes occurs beyond the scope of the indexed snapshot

### Requirement: Status and run history endpoints
The system SHALL expose read-only status and run history endpoints that return the current run, queue depth, and `pipeline_runs` history without reading note content or making network calls.

#### Scenario: Current status query
- **WHEN** a client GETs `GET /v1/status` with a valid token
- **THEN** the system returns HTTP 200 with `{ currentRun, queueDepth, queuedRuns: [{ id, pipeline, trigger, scope, priority, enqueuedAt }], progress: { processed, total, currentNoteId } | null }` sourced from `orchestration/status` and `orchestration/runner` without reading Joplin note content

#### Scenario: Run history query with filters
- **WHEN** a client GETs `GET /v1/runs?pipeline=structural&status=success&limit=20&offset=0`
- **THEN** the system returns HTTP 200 with `pipeline_runs` rows ordered by `started_at` DESC, filtered and paginated per the query params, supported by the `pipeline_runs(pipeline, started_at)` index; invalid filter values yield HTTP 400

#### Scenario: Run detail query
- **WHEN** a client GETs `GET /v1/runs/:id`
- **THEN** the system returns HTTP 200 with the full `pipeline_runs` row or HTTP 404 if the id does not exist

#### Scenario: CLI status commands
- **WHEN** the user runs `echo status` or `echo status --history --limit 10` or `echo status --run <id>`
- **THEN** the CLI calls the corresponding status endpoint when online and prints the current run, queue, and history; when offline it reads `pipeline_runs` directly from the SQLite DB (read-only) and prints the same shape

### Requirement: CLI client commands and distribution
The system SHALL provide a standalone `echo` CLI client that exposes `pipeline run`, `search`, `status`, `update`, help, and version commands, shares the schema/type package with the plugin, and authenticates to the endpoint via the persisted token.

#### Scenario: CLI help and version
- **WHEN** the user runs `echo --help` or `echo --version` or `echo <command> --help`
- **THEN** the CLI prints usage, subcommand descriptions, and the semver version matching the plugin release, without requiring the plugin to be running

#### Scenario: Update triggers as aliases for pipeline run
- **WHEN** the user runs `echo update --note <id>` or `echo update --folder <id>` or `echo update --all` (aliases for `echo pipeline run`)
- **THEN** the CLI enqueues the corresponding scoped run with the same pipeline/force semantics and prints the runId

#### Scenario: CLI token handling
- **WHEN** the CLI starts
- **THEN** it resolves the token from (1) `ECHO_TOKEN` env var if set, else (2) the plugin data dir token file; if neither exists it prints a diagnostic with the expected data-dir path and exits with code 2 without making an unauthenticated request

#### Scenario: Offline direct reads share schema package
- **WHEN** the CLI is built
- **THEN** it imports schema DDL, row types, and DB helpers from a shared package (e.g., `src/schema` re-exported as `@echo.ai/schema`) rather than duplicating table definitions, so a schema migration that changes `chunks_fts` or `pipeline_runs` requires no CLI-side drift; a build fails if the shared import is missing

#### Scenario: CLI exit codes
- **WHEN** a CLI command succeeds, fails due to user error, or fails due to endpoint/auth error
- **THEN** it exits with code 0 on success, code 1 on user-error (bad args, unknown note/folder), and code 2 on transport/auth error (unreachable, 401/403), printing the error to stderr

### Requirement: Plugin registration and documentation of localhost server
The system SHALL register Joplin commands that surface the endpoint state and SHALL document the localhost-server pattern, its loopback+token threat model, and its reviewed status in project docs and settings UI.

#### Scenario: Endpoint commands registered
- **WHEN** the plugin starts
- **THEN** it registers commands such as "Echo: Copy CLI token" and "Echo: Show endpoint status" that are visible in the command palette and that report the bound port, token fingerprint, and current run without exposing the raw token

#### Scenario: Localhost server is documented as reviewed dual-use
- **WHEN** a user or reviewer inspects the settings UI or README/security docs
- **THEN** they find an explicit note that the loopback HTTP server is a deliberate, reviewed dual-use behavior (enables scheduling/automation), bound to loopback only, guarded by per-install token, never exposes decrypted note content to the network, and is disabled when the plugin is stopped

#### Scenario: No Joplin sync of endpoint state
- **WHEN** the endpoint persists token/port
- **THEN** the files reside only in the plugin data dir (outside sync) and no note content or token is written to Joplin sync folders
