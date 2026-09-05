## Why

Every pipeline and every UI in echo.ai reads and writes the index database, but the data model does not exist yet. Defining the schema up front (as the first real migration) gives later changes a stable contract to build against.

## What Changes

- Define the full domain DDL as migration 1 on top of the `storage` bootstrap from `echo-foundation`:
  - `notes` — note snapshot (id, title, notebook, content hash, indexed-at, status)
  - `chunks` — chunked note text with ordering; `chunks_fts` external-content FTS5 table for BM25
  - `embeddings` — chunk vectors (model, dims, blob) for dense retrieval
  - `nodes` / `edges` — **layered graph** with a `layer` column (`structural | semantic`), `kind` (note/entity), edge `type` (link/tag/backlink/relation/mention), weight
  - `entities` / `relations` — semantic entity canonicalization and typed relations
  - `index_state` — per-note content-hash and pipeline status for delta tracking
  - `pipeline_runs` — run log (pipeline, trigger, start/end, counts, errors)
- Indexes and constraints supporting delta tracking (content hash lookups), layer/type filtering, and graph traversal.
- No pipeline logic; this change is pure schema.

## Capabilities

### New Capabilities
- `schema`: the echo.ai index data model — tables, columns, constraints, indexes, and migration 1 DDL

### Modified Capabilities
- None.

## Impact

- Consumes `storage` from `echo-foundation` (migration mechanism).
- Consumed by `echo-indexing`, `echo-semantic-graph`, `echo-retrieval`, `echo-orchestration`, `echo-graph-view`.
- The layered `nodes`/`edges` design is what later enables the structural/semantic/overlap views in `echo-graph-view` and layer-aware retrieval in `echo-retrieval`.