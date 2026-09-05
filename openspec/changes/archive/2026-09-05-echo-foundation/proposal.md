## Why

Nothing exists yet for echo.ai — before any schema, pipeline, or UI can be built, there must be a runnable Joplin plugin shell with bootstrapped storage, settings, and an LLM provider abstraction that every later change consumes.

## What Changes

- Scaffold the echo.ai Joplin desktop plugin: TypeScript + Webpack build, standard plugin layout (`index.ts` bootstrap, `plugin.config.json`, dist packaging).
- Register plugin lifecycle (`onStart`/`onStop`), a plugin data directory, and an `echo.*` settings section (provider, base URL, model selection).
- Bootstrap the SQLite index database in the plugin data dir with a **versioned migration mechanism** (`schema_migrations` table); ships with an initial empty migration.
- Define the LLM provider interface (chat, embeddings, extraction) and implement the **local Ollama provider** (OpenAI-compatible `/v1` endpoint); a "test connection" command verifies provider reachability.
- Establish the security posture: the index DB is plaintext in the plugin data dir (Option A), never synced; note content stays on-machine; network only to the configured provider.

## Capabilities

### New Capabilities
- `plugin/runtime`: plugin bootstrap, lifecycle, data directory, command registration skeleton
- `storage`: SQLite initialization, versioned migrations, connection management
- `settings`: registered `echo.*` settings keys, defaults, validation
- `llm/providers`: LLM provider interface plus the local Ollama implementation and connection test

### Modified Capabilities
- None (greenfield).

## Impact

- New plugin project; no existing code is touched.
- Dependencies: none.
- Downstream: `echo-schema` adds the first real migration; `echo-indexing` consumes `storage` and `llm/providers`; `echo-config-ui` later surfaces these settings.
- Build tooling: webpack, TypeScript; runtime dep: `sqlite3` via `joplin.require`.