## Context

`echo-foundation` (archived 2026-09-05) shipped the storage module (`src/storage/db.ts`, `src/storage/migrations.ts`) with a single shared SQLite connection via `joplin.require('sqlite3')` and a versioned migration mechanism (`schema_migrations` table, migrations applied in order inside transactions). The baseline migration (version 1) is empty. Every downstream change (`echo-indexing`, `echo-semantic-graph`, `echo-retrieval`, `echo-orchestration`, `echo-graph-view`) depends on the domain tables defined in this change.

The index DB is plaintext in the plugin data dir (Option A), never synced, with `PRAGMA foreign_keys = ON`. No pipeline logic belongs here — pure DDL.

See proposal.md - Why for motivation and specs/schema/spec.md for the normative requirements.

## Goals / Non-Goals

**Goals:**
- Define the first real migration (version 2) that creates all domain tables in one transaction, consumable by every later pipeline.
- Provide the layered `nodes`/`edges` design that enables structural/semantic/overlap views and layer-aware retrieval.
- Establish FTS5 for BM25, blob vectors for dense retrieval, and `index_state`/`pipeline_runs` for delta tracking and run history.

**Non-Goals:**
- Any pipeline logic (chunking, embedding, extraction) — that is `echo-indexing`/`echo-semantic-graph`.
- Any UI or retriever implementation.
- Remote provider support or sync encryption.

## Decisions

### Migration versioning: version 2 as domain DDL
Version 1 is the empty baseline from `echo-foundation`; this change adds version 2 containing all domain tables. Done as a single migration so a fresh DB goes from 1 → 2 atomically and existing DBs upgrade cleanly.
- **Alternative:** Amend version 1 to contain DDL — would require editing archived change, breaks migration history. Rejected.

### SQLite DDL organization and foreign keys
Tables are created in dependency order (`notes` → `chunks` → `embeddings` → `entities` → `nodes` → `edges`/`relations` → `index_state` → `pipeline_runs`) with foreign keys and `ON DELETE CASCADE/SET NULL` as specified in the spec. `PRAGMA foreign_keys = ON` is set on each connection (already done in `db.ts` or enforced at migration time).
- **Why:** Enforces referential integrity; cascades handle note deletion without orphan rows.
- **Alternative:** No FKs, manual cleanup in pipelines — error-prone, rejected.

### FTS5 external content for chunks
`chunks_fts` is a `VIRTUAL TABLE USING FTS5(content, content='chunks', content_rowid='rowid')` with triggers `chunks_ai`, `chunks_ad`, `chunks_au` to keep the index synchronized. Chunk content remains in `chunks.content`; FTS5 is an index only.
- **Why:** External content avoids duplicating text in the FTS shadow tables; triggers are the documented SQLite pattern for this mode.
- **Alternative:** Content-sync FTS5 (stores copy) — doubles storage, unnecessary. Trigram tokenizer for fuzzy — deferred to `echo-retrieval`'s fuzzy retriever; base FTS5 suffices here.

### Vector storage: BLOB + dims + model
`embeddings.vector` is a `BLOB` (Float32 array serialized), with `dims` and `model` columns for validation and model-change detection. No vector extension (sqlite-vec) is used.
- **Why:** Pure-JS, no native module; kNN will be brute-force cosine in `echo-retrieval` (acceptable for thousands of chunks). Storing model/dims allows invalidation when embedding model changes.
- **Alternative:** Bundle `sqlite-vec` — native build, fragile with Joplin's Webpack packaging. Rejected.

### Layered graph: layer column with CHECK
`nodes.layer` and `edges.layer` are `TEXT CHECK (layer IN ('structural','semantic'))`. Edge `type` is constrained to `('link','tag','backlink','relation','mention')`. `nodes.kind` is `('note','entity','chunk')`.
- **Why:** Simple string enum, SQLite-enforced, enables `WHERE layer = 'structural'` and overlap queries without extra tables.
- **Alternative:** Separate tables per layer — duplicates schema, complicates overlap view joins. Rejected.

### Entities/relations separation
`entities` holds canonicalized entities (unique `canonical_name`, JSON `aliases`), `relations` holds typed edges between entities with `evidence_chunk_id`. `nodes` can reference an `entity_id` to bridge the graph and semantic tables.
- **Why:** Canonicalization needs dedup (unique name) and alias tracking; separating from `nodes`/`edges` keeps the generic graph layer clean.

### Index state and pipeline runs
`index_state` is keyed by `note_id` with `content_hash` and per-pipeline status columns. `pipeline_runs` logs each run with `pipeline`, `trigger`, `scope`, `status`, timestamps, and counts.
- **Why:** Single row per note for delta checks (`content_hash` comparison); run log supports UI history and CLI status without scanning `index_state`.

### Indexes for query patterns
Indexes on `notes(content_hash)`, `chunks(note_id, chunk_index)`, `edges(source_id)`, `edges(target_id)`, `edges(layer, type)`, `nodes(layer)`, `pipeline_runs(pipeline, started_at)`, `index_state(updated_at)`.
- **Why:** Covers delta scan, chunk retrieval, graph traversal, layer/type view filtering, and run history ordering.

## Risks / Trade-offs

- [FTS5 trigger maintenance] → Triggers must be tested on each SQLite version Joplin ships; wrap table creation in idempotent `IF NOT EXISTS` and verify triggers fire in unit tests.
- [BLOB vectors not queryable by SQLite] → Dense retrieval will be application-side kNN; acceptable scale (thousands of chunks) but document that future scale may require a native extension.
- [Migration is large and must be atomic] → Single transaction (`BEGIN`/`COMMIT` in migrations framework); on failure `ROLLBACK` leaves DB at version 1, retry on next startup.
- [CHECK constraints limit type evolution] → New edge/node types require a follow-up migration to alter CHECK; acceptable for initial contract, add migration when needed.
- [Plaintext index DB] → Accepted per Option A; noted in spec and design, no change here.

## Migration Plan

- Adds migration version 2 to `src/storage/migrations.ts` containing all DDL. On startup, `applyMigrations` applies it if `schema_migrations` is at version 1.
- **Deploy:** Ship with plugin build; existing users with version 1 DBs auto-migrate on next launch.
- **Rollback:** No downgrade migration; rollback is restoring the plugin data dir or deleting the DB file. No data loss beyond the index (re-indexable from Joplin notes).

## Open Questions

None.
