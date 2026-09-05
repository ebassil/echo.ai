## 1. Plugin Scaffold

- [x] 1.1 Initialize the plugin project: TypeScript + Webpack build config, standard Joplin plugin layout (`src/index.ts`, `plugin.config.json`, dist packaging)
- [x] 1.2 Register plugin lifecycle (`onStart`/`onStop`) with error handling and clean shutdown
- [x] 1.3 Resolve and create the plugin data directory on startup; expose its path
- [x] 1.4 Register the command skeleton (connection test command invocable from the command palette)

## 2. Storage

- [x] 2.1 Create the storage module backed by `joplin.require('sqlite3')` with a single managed connection
- [x] 2.2 Implement the versioned migration mechanism (`schema_migrations` table, apply pending migrations in order within a transaction)
- [x] 2.3 Ship the initial empty baseline migration
- [x] 2.4 Open the index DB in the plugin data dir on startup and close it on shutdown

## 3. Settings

- [x] 3.1 Register the `echo.*` settings section (provider, base URL, model selection) with defaults
- [x] 3.2 Add settings validation (well-formed HTTP(S) base URL, non-empty model name) and surface invalid values to the user

## 4. LLM Provider

- [x] 4.1 Define the provider interface (chat, embeddings, extraction)
- [x] 4.2 Implement the local Ollama provider over its OpenAI-compatible `/v1` endpoint using `fetch`
- [x] 4.3 Implement the connection test command that verifies provider reachability and reports success/failure with details
- [x] 4.4 Wire provider configuration from settings and verify the plugin builds without errors