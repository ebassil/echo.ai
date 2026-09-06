# echo.ai

**LLM-powered interaction with your Joplin notes.**

echo.ai is a [Joplin](https://joplinapp.org/) plugin (with a companion `echo` CLI) that adds a private, local-first AI layer on top of your note vault: chat with retrieved note context, explore your notes as a knowledge graph, and compose a retrieval pipeline. Everything runs against your own local models — your notes never leave your machine.

> Status: early (v0.1.0). Built as a series of spec-driven subsystems (see [`openspec/`](openspec/)); the chat, graph, and config UIs are the most recently completed work.

## Highlights

- **Private by default** — chat, embeddings, entity extraction, and reranking all call your local [Ollama](https://ollama.com/) instance over its OpenAI-compatible endpoint. No cloud API keys, no note egress.
- **Chat with your notes** — a Joplin panel that streams answers grounded in your indexed notes, with clickable `[n]` citations back to the source note.
- **Composable retrieval** — BM25 (FTS5), TF-IDF, fuzzy, dense (embedding kNN), and graph retrievers are fused with Reciprocal Rank Fusion, then optionally reranked.
- **Semantic knowledge graph** — extracts entities and relations from your notes, canonicalizes duplicates, and runs cascades + enrichment (suggested tags/wiki-links).
- **Companion CLI** — trigger pipelines, search, and check status from your terminal, cron, or scripts via a secured loopback endpoint (or fully offline against the index).
- **Fully offline-capable** — the index is a plaintext SQLite database in your plugin data dir, readable directly by the CLI with `--offline`.

## Requirements

- **Joplin desktop ≥ 3.0** (the plugin uses the modern panels/settings API)
- **Node.js ≥ 22.5** — only needed to *build* the plugin and run tests (uses the built-in `node:sqlite` module); end users install a prebuilt `.jpl`
- **Ollama** running locally, with at least one chat model pulled (e.g. `llama3`) plus an embedding model used by your provider

## Installation

### From source (build the plugin)

```bash
npm install          # install root dev dependencies
npm run dist         # webpack build + create .jpl archive
```

This produces `publish/com.echoai.joplin-plugin.jpl`. Install it in Joplin:

1. Open **Tools → Options → Plugins**
2. Click **Install from file...** and select the `.jpl` archive
3. Enable the plugin and restart Joplin if prompted

Or, for development, install from the `./dist` directory (webpack output) — see [Development](#development).

### CLI (`echo`)

```bash
cd cli
npm install
npm run build        # tsc → ./dist
npm link             # expose the `echo` binary on PATH (or `npm install -g .`)
```

### First-time setup

1. Make sure Ollama is running: `ollama serve`, and pull your models: `ollama pull llama3` (chat) and your provider's embedding model.
2. In Joplin, run **Echo AI: Test connection** (Tools → Options → Commands, or via the command palette) to verify the plugin can reach your provider.
3. The plugin automatically enqueues a catch-up indexing run on startup. You can also trigger one manually — see [Usage](#usage).
4. Copy the CLI token via **Echo: Copy CLI token** when you want to use the terminal CLI (the token is also persisted in your plugin data dir as `echo-token`).

## Configuration

All settings live in Joplin under **Tools → Options → echo.ai** (or the matching `echo.*` keys in your Joplin profile settings file).

### Provider

| Setting | Default | Description |
|---|---|---|
| LLM provider | `ollama` | Currently `ollama` only (OpenAI-compatible `/v1`). |
| Provider base URL | `http://localhost:11434` | Base URL of the provider's `/v1` endpoint. |
| Model name | `llama3` | Model used for chat, extraction, and embeddings. |
| Chat model (optional) | *(empty)* | Overrides the model for chat; falls back to Model name. |
| Extraction model (optional) | *(empty)* | Overrides the model for semantic extraction; falls back to Model name. |
| Connection test timeout | `15s` | Max wait for the connection test before giving up. |

### Indexing

| Setting | Default | Description |
|---|---|---|
| Chunk size (chars) | `2000` | Max characters per indexed chunk (heading-aware). |
| Chunk overlap (chars) | `200` | Overlap between consecutive chunks. |
| Embedding batch size | `32` | Chunks per embedding request. |

### Semantic graph

| Setting | Default | Description |
|---|---|---|
| Canonicalization mode | `exact` | Entity dedup: `exact` (case-fold) or `embedding` (cosine similarity). |
| Canonical similarity | `85` | Cosine threshold for embedding merge (`70–95`, stored as ×100). |
| Extraction granularity | `per-note` | `per-note`, `per-chunk`, or both. |
| Extraction concurrency | `1` | Max parallel extraction calls (`1–4`). |
| Extraction max chars | `8000` | Per-note extraction window cap; longer notes use chunked fallback. |
| Semantic cascade mode | `lazy` | Re-extract neighbors eagerly or not at all. |
| Cascade depth | `1` | Depth for eager cascades (`1–5`). |
| Cascade fanout cap | `50` | Max neighbor notes per cascade level (`10–200`). |
| Enable structural enrichment | off | Writes suggested tags/wiki-links back into your notes. |

### Retrieval

| Setting | Default | Description |
|---|---|---|
| Enabled retrievers | all on | JSON map: `{"bm25":true,"tfidf":true,"fuzzy":true,"dense":true,"graph":true}` |
| Dense retriever k | `20` | Neighbors fetched for dense retrieval. |
| Token budget | `4000` | Context window budget for assembled retrieval context. |
| Max chunks per note | `3` | Cap on context chunks from a single note. |
| RRF k parameter | `60` | Reciprocal Rank Fusion constant. |
| Enable reranking | off | Reranks fused results with a dedicated model. |
| Rerank model | *(empty)* | Model for reranking; falls back to Model name. |

### Chat & orchestration

| Setting | Default | Description |
|---|---|---|
| Chat system prompt | *(built-in)* | Default system prompt (overridable per conversation). |
| Chat history budget (tokens) | `8000` | Approximate context cap for history trimming. |
| Orchestration schedule | `off` | Periodic reindex: `off`, interval (`30m`, `6h`, `1d`, …), or cron (`0 */6 * * *`). |
| CLI endpoint port | `0` | Loopback CLI HTTP port; `0` = ephemeral (persisted for the CLI). |

### CLI

The `echo` CLI reads the endpoint port and token from your plugin data directory. Override with environment variables:

| Env var | Purpose |
|---|---|
| `ECHO_TOKEN` | Token to authenticate against the loopback endpoint (defaults to `<dataDir>/echo-token`). |
| `ECHO_DATA_DIR` | Plugin data directory (defaults to Joplin's plugin data dir discovery). |

## Usage

### In Joplin

- **Chat panel** — opens on plugin start. Choose or create a conversation, pick a model/system prompt, toggle note context (`Use notes as context`) and per-retriever toggles (BM25 / TF-IDF / Fuzzy / Dense / Graph). Streamed answers cite sources as `[n]`; click a citation to open the note.
- **Commands** (command palette or Tools → Options → Commands):
  - `Echo: Reindex all`
  - `Echo: Extract semantics (all)`
  - `Echo: Reindex and extract all`
  - `Echo AI: Test connection`
  - `Echo: Show CLI endpoint status` / `Echo: Copy CLI token` / `Echo: Rotate CLI token`

### Terminal (`echo`)

```bash
# Trigger a pipeline run
echo pipeline run --all
echo pipeline run --note <noteId> --pipeline semantic
echo pipeline run --folder <folderId> --force

# Search the index (via the running plugin)
echo search "what did I decide about the launch date?"
echo search "api design" --retrievers bm25,dense --limit 5

# Search fully offline (no Joplin running), read-only
echo search "notes from meetings" --offline

# Status & history
echo status
echo status --history --limit 50
echo status --run <runId>

# Scheduling automation: e.g. every night via cron
0 2 * * * echo pipeline run --all
```

Exit codes: `0` success, `1` user error, `2` transport/authentication error.

> **Security:** the CLI endpoint binds to `127.0.0.1` only and requires a per-install 256-bit bearer token. It never exposes decrypted note bodies over the network (only already-indexed data) and defers work while your vault is locked. See [`docs/cli-security.md`](docs/cli-security.md) for the full posture.

## Architecture

```
src/
├── index.ts               plugin entry (onStart/onStop)
├── plugin/                boot runtime, data-dir init
├── settings/              settings registry, validation, hot-reload
├── storage/               SQLite layer (node:sqlite)
├── schema/                shared DB schema (plugin + CLI)
├── indexing/              parse → chunk → embed → hash → persist, file watching, vault gating
├── semantic/              entity/relation extraction, canonicalization, cascade, enrichment
├── orchestration/         serial runner/queue, scheduler, triggers, commands
├── retrieval/             BM25, TF-IDF, fuzzy, dense, graph + RRF fusion, context assembly, rerank
├── chat/                  chat controller, store, protocol, panel + webview UI
├── cli/                   loopback HTTP endpoint (Bearer token) + plugin commands
└── llm/                   provider interface, Ollama client, health checks
cli/                       standalone Commander CLI (online + offline modes)
tests/                     Node test-runner suite (unit)
openspec/                  spec-driven change records & active specs
docs/cli-security.md       CLI endpoint security posture
```

Design decisions, schemas, and per-subsystem specs live in [`openspec/specs/`](openspec/specs/) and past change proposals in [`openspec/changes/`](openspec/changes/).

## Development

```bash
npm install
npm run build     # webpack: Joplin plugin (dist/)
npm run dist      # build + extra scripts + .jpl archive in publish/
```

To run the plugin from source in Joplin, point **Install from file...** at `./dist` after a build (the webpack output includes `manifest.json`). Restart Joplin after recompiling.

### Tests

Requires Node ≥ 22.5. Uses Node's built-in test runner with a `mock-api` shim and on-the-fly TypeScript loading.

```bash
node --test tests/delta.test.js                            # single file
node --test tests/ 2>/dev/null || true                     # whole suite (see note)
cd cli && npm test                                          # CLI tests
```

> The suite is under active development; run individual test files (`tests/**/*.test.js`) if the full glob trips on files that need a running provider.

### Roadmap

Open design proposals in [`openspec/changes/`](openspec/changes/): `echo-graph-view` (graph visualization) and `echo-config-ui` (settings UI in the panel).

## License

MIT. See [`package.json`](package.json).