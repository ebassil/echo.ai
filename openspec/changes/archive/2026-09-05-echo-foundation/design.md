## Context

Greenfield Joplin desktop plugin (Electron, TypeScript + Webpack). Plugins run in a BrowserWindow with Node access; SQLite is available via `joplin.require('sqlite3')`, native modules are otherwise hard to bundle, and `fetch` is available for network. Index storage is a plaintext SQLite DB in the plugin data dir (Option A), never synced. See proposal.md - Why for motivation; specs define the required behavior.

## Goals / Non-Goals

**Goals:**
- A runnable plugin shell that every later change (`echo-schema`, `echo-indexing`, `echo-config-ui`) builds on
- Versioned, migration-based SQLite storage with a managed connection
- An `echo.*` settings surface with defaults and validation
- A provider abstraction with one concrete local-Ollama implementation, plus a connection test command

**Non-Goals:**
- Any schema beyond the empty initial migration (that is `echo-schema`'s job)
- Remote provider implementations (later)
- Embeddings/extraction pipeline logic (later)
- Any UI beyond command registration (later)

## Decisions

### Module layout mirrors capabilities
Source is organized by capability so later changes map cleanly onto the planning structure: `plugin/` (runtime), `storage/` (db), `settings/`, `llm/` (provider interface + providers/ollama).
- **Why:** Keeps delta specs and code paths aligned; each subsequent change touches a bounded surface.
- **Alternative:** A flat `src/` with feature folders — less aligned with the capability structure.

### SQLite via `joplin.require('sqlite3')`
Use Joplin's bundled sqlite3 rather than bundling a native module.
- **Why:** Native modules are hard to bundle with Webpack into a Joplin plugin; Joplin already ships sqlite3, so this adds no packaging risk.
- **Alternative:** Bundling `better-sqlite3` — synchronous API is nicer but native build is fragile across platforms.

### Versioned migrations with a `schema_migrations` table
A `schema_migrations` table records the applied schema version; migrations are applied in order on startup, with the first migration being empty (version 1 baseline).
- **Why:** Later changes (`echo-schema`) land real migrations without schema-version drift; an empty baseline makes the mechanism verifiable before real schema exists.
- **Alternative:** No versioning, DDL on each startup — loses upgrade path and makes `echo-schema` risky.

### Single shared connection
The storage module owns one connection, opened on startup and closed on `onStop`.
- **Why:** sqlite3 is not designed for concurrent writers from multiple connections; a single owner centralizes error handling and shutdown.
- **Alternative:** Open-per-call connections — simpler but racy and leaks handles.

### Settings as a thin, validated registry
Settings are declared once (key, label, default, validator) and registered with Joplin; a small helper resolves effective values with defaults.
- **Why:** Central declaration prevents key drift and gives one validation path; matches the proposal's `echo.*` naming.
- **Alternative:** Ad-hoc `joplin.settings.value()` calls scattered across modules — validation and defaults duplicated.

### Provider interface with a fetch-based Ollama client
One interface (`chat`, `embeddings`, `extraction`) implemented by the Ollama provider using `fetch` against the OpenAI-compatible `/v1` endpoint configured in settings.
- **Why:** A single interface lets consumers stay provider-agnostic and lets later providers (remote OpenAI-compatible) drop in. Pure `fetch` avoids native deps.
- **Alternative:** Using the `openai` SDK — pulls in a dependency and assumes OpenAI wire format; the interface still has to exist, so implementing directly is simpler.

## Risks / Trade-offs

- [Joplin's bundled sqlite3 version/API drift] → Wrap sqlite access behind the storage module so a swap to an alternative backend is localized.
- [Startup failure leaves DB in partial state] → Apply migrations inside a transaction and treat failure as fatal-with-message; DB file remains intact for manual recovery.
- [Plaintext index DB on disk] → Accepted per Option A; DB lives only in the plugin data dir, never synced, and the OS-level encryption is the boundary.
- [Ollama `/v1` compatibility quirks across versions] → Test connection command surfaces endpoint details; provider isolates wire-format differences.

## Migration Plan

No prior version exists; the migration mechanism ships with an empty baseline migration. Rollback for this change is removing the plugin data dir / plugin itself — no data migrations are at stake.

## Open Questions

None.