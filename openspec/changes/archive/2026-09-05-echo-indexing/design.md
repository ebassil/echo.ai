## Context

`echo-foundation` (archived) provides the plugin shell (`src/plugin/runtime.ts`), a single shared SQLite connection via `joplin.require('sqlite3')` (`src/storage/db.ts`), versioned migrations (`src/storage/migrations.ts`), and the LLM provider interface (`src/llm/provider.ts` with `src/llm/providers/ollama.ts`). `echo-schema` (archived) ships migration version 2 that creates all domain tables: `notes`, `chunks` + `chunks_fts` (FTS5 external content with triggers), `embeddings` (BLOB vectors), `nodes`/`edges` with `layer IN ('structural','semantic')`, `entities`/`relations`, `index_state`, and `pipeline_runs`, plus indexes and `PRAGMA foreign_keys = ON`.

This change lands the first real pipeline: structural indexing. It is the sole producer of chunks, FTS rows, structural graph, and chunk embeddings, and the entry point for every downstream consumer (`echo-semantic-graph`, `echo-retrieval`, `echo-graph-view`, `echo-orchestration`, `echo-cli`). The Joplin API surface it consumes is `joplin.data` (notes/folders/tags/pages), `joplin.settings`, and workspace events. Note content is E2EE at rest but readable decrypted through the API only while the vault is unlocked; the index itself is plaintext in the plugin data dir (Option A).

See proposal.md - Why for motivation and specs/indexing/spec.md for normative requirements.

## Goals / Non-Goals

**Goals:**
- A deterministic structural pipeline: fetch → parse markdown → heading-aware chunk → extract wiki-links/tags/backlinks → write structural graph → embed chunks → update `notes`/`index_state`
- Content-hash delta: skip hash-equal notes, purge stale chunks/edges/embeddings on change or deletion, force override
- Three scopes sharing one engine: single note, folder (with descendant resolution), all notes
- Event-driven watching: debounced `onNoteChange`/`onNoteDelete`, vault-unlock gate with queued catch-up
- Correctness with the existing schema: respect FK CASCADE, FTS triggers, CHECK constraints, and layer discipline

**Non-Goals:**
- Semantic extraction (entities/relations, canonicalization, cascade) — that is `echo-semantic-graph`
- Retrieval (BM25/TF-IDF/fuzzy/dense/graph retrievers, RRF, token-budget context assembly) — that is `echo-retrieval`
- Scheduling, queuing, cancellation, or `pipeline_runs` history UI — that is `echo-orchestration` (this change may write minimal run metadata if needed, but orchestration owns the abstraction)
- Remote/secondary LLM providers — Ollama via `provider.embeddings` is already available; no new provider here
- UI: graph view, settings page, chat — separate changes

## Decisions

### Pipeline module location: `src/indexing/`
New module `src/indexing/` exposing `indexNote`, `indexFolder`, `indexAll`, and `watchIndexing`. Internal helpers: `chunker.ts`, `markdown.ts`, `extractors/links.ts`, `extractors/tags.ts`, `graphWriter.ts`, `embedder.ts`, `hash.ts`, `delta.ts`, `scopes.ts`, `events.ts`.
- **Why:** Mirrors capability `indexing`; keeps the first pipeline isolated from `storage/`, `llm/`, and the future `semantic/` module. Downstream changes import only the indexing service interfaces.
- **Alternative:** Co-locate in `src/storage/` — storage owns raw DB access, not pipeline orchestration. Rejected.

### Joplin data access: paginated `joplin.data.get` + event listeners
Scans use `joplin.data.get(['notes'], { fields: [...], page: N, limit: 100 })` style pagination; single-note fetches use `joplin.data.get(['notes', id])`; folder scoping resolves descendants via `joplin.data.get(['folders', id, 'notes'])` or iterative folder-tree walk. Events via `joplin.workspace.onNoteChange` / `joplin.workspace.onNoteSelectionChange` where available, otherwise `joplin.data` polling fallback. Version-check the Joplin API in `plugin/runtime.ts`.
- **Why:** Joplin's data API is paginated by design; bulk-fetching all notes at once would OOM on large vaults. Pagination + field projection minimizes memory and deserialization.
- **Alternative:** Use search API `joplin.data.get(['search'], { query, type: 'note' })` for scope resolution — expressive but slower and dependent on Joplin's search index freshness. Rejected for primary path.

### Markdown parsing: pure-JS, heading-aware chunker
Use a pure-JS markdown parser (e.g., `marked` or `markdown-it` lexer, no native deps) to split on heading boundaries (`#`–`######` with ATX/setext detection) then enforce a character/token ceiling per chunk (default ~512 tokens / ~2000 chars, overlap ~50 tokens). Front matter (`---` YAML) is stripped before chunking but tags inside body ` #tag` forms are still extracted. Code fences are treated as opaque blocks (not split mid-fence).
- **Why:** Pure-JS satisfies the platform constraint (no native bundling). Heading-aware chunking preserves semantic coherence for retrieval better than naive fixed-size splits; ceiling + overlap controls embedding model context windows.
- **Alternative:** Webpack-bundle `unified`/`remark` — heavier, more correct AST but larger bundle for little gain in this use case. `markdown-it` lexer is sufficient for headings + fences + wikilink placeholders.

### Content hashing: SHA-256 of normalized title + body
Hash = `SHA256( title.trim() + '\n' + body.normalize('NFC') )` computed in JS (`crypto` submodule or `js-sha256`). Stored in `notes.content_hash` and `index_state.content_hash`. Comparison is string equality.
- **Why:** Cheap delta check (one primary-key lookup per note in `index_state`), no need to diff chunks if hash matches. Normalization avoids spurious re-indexing on Unicode composition differences.
- **Alternative:** Hash per chunk — finer granularity but multiplies hash storage/comparison cost; note-level hash is the right granularity before chunking.

### Transaction boundaries: one SQLite transaction per note
Each note's delete-old → insert chunks → insert embeddings → write graph → upsert `notes`/`index_state` is wrapped in `BEGIN IMMEDIATE` / `COMMIT` (or `db.serialize` with `run('BEGIN')`). Failures roll back the note and mark `index_state.structural_status='failed'` with `error` truncated to 1k chars; other notes in the batch are unaffected.
- **Why:** Keeps the index consistent (no partial chunk sets) without locking the DB for the entire `indexAll` run. Per-note atomicity is the minimal correctness boundary; batch-wide transactions would hold locks too long and amplify failure blast radius.
- **Alternative:** One transaction for the whole run — simpler but holds `IMMEDIATE` lock for minutes on large vaults and forces full rollback on single-note embedding failure. Rejected.

### Embedding batching: chunked `provider.embeddings` calls
Group up to N chunks per `embeddings` call (default 32, configurable), serialize Float32 → BLOB via `Buffer.from(Float32Array.buffer)`, store `model` and `dims` from provider response metadata. Rate-limit with simple sequential batches (no parallel storms against local Ollama).
- **Why:** Ollama's `/v1/embeddings` accepts batched input; fewer round-trips than per-chunk calls. Sequential batches avoid overwhelming a local model that already competes for VRAM with chat/extraction.
- **Alternative:** Fully parallel batches — faster but causes OOM on small Ollama hosts. A later `echo-orchestration` work-queue can parallelize with backpressure; indexing itself stays conservative.

### Structural graph writing: note node + link/tag/backlink edges, layer='structural'
On each note index: upsert a `nodes` row `{ id: "note:<joplinId>", layer: 'structural', kind: 'note', label: note.title, note_id, ... }`; for each resolved wiki-link produce `edges` `{ layer:'structural', type:'link', source_id: sourceNoteNode, target_id: targetNoteNode }`; for each Joplin tag produce or reuse `nodes` `{ id: "tag:<tagId>", layer:'structural', kind:'entity', label: tag.title }` + `edges { type:'tag' }`; backlink edges (`type:'backlink'`) are either the reverse view of `link` edges or materialized reverse edges (pick one and be consistent — recommend materialized reverse for graph view simplicity). Stale edges for the source note are deleted before re-inserting (scoped delete `WHERE source_id = ? AND layer='structural'`).
- **Why:** Uses the existing `layer` discipline; structural edges are separable from future semantic edges by `WHERE layer='structural'`. Materialized backlinks make `graph-view` queries trivial (no reverse-join logic in the UI).
- **Alternative:** Virtual backlinks (no rows, computed at query time) — cheaper write but pushes complexity into every reader. Rejected for structural simplicity.

### Delta and stale cleanup: leverage FK CASCADE + scoped deletes
`chunks.note_id REFERENCES notes(id) ON DELETE CASCADE` and `embeddings.chunk_id REFERENCES chunks(id) ON DELETE CASCADE` mean deleting chunks deletes embeddings and FTS rows automatically (triggers handle `chunks_fts`). Structural edges cleanup is explicit scoped deletes by source note. `index_state` and `notes` are explicitly deleted on note purge.
- **Why:** Matches the migration's FK design; minimal manual cleanup code, fewer orphan rows.
- **Alternative:** Manual deletes in application code for everything — more code, more races.

### Event watching and debounce
Register `joplin.workspace.onNoteChange` (if available) or `joplin.data` polling. Debounce with a shared timer (default 1200 ms) coalescing multiple edits to the same note into one enqueue. Events emitted while vault is locked are queued in memory (bounded queue, e.g., 1000 ids, deduped) and flushed on `vaultUnlock` / next startup delta scan. Attach listeners in `plugin/runtime.ts` after `watchSettings()` and DB open.
- **Why:** Rapid typing fires many change events; debouncing avoids re-chunking on every keystroke. The unlock gate respects E2EE semantics (no decrypted reads while locked).
- **Alternative:** Immediate per-event indexing — wasteful and competes with typing latency.

### Scope resolution and descendant folders
Folder scope resolves by fetching the folder's descendant tree (BFS over `joplin.data.get(['folders'])` parent relations) then fetching notes per folder with pagination. A `scopes.ts` helper returns `noteId[]` for any scope.
- **Why:** Joplin's API does not return recursive folder contents directly; recursive resolution is necessary for "reindex folder" to feel correct.
- **Alternative:** Only direct children — surprising UX, rejected.

## Risks / Trade-offs

- [Embedding Ollama unavailable → blocks chunk persistence if coupled] → Embed after chunks are committed or in same per-note transaction but handle provider failure by persisting chunks/graph with `structural_status='failed'` and retrying embeddings later; surface error to user via plugin message box / future status API.
- [Large vaults (10k+ notes) starve the event loop during `indexAll`] → Paginate notes, yield per page with `setImmediate`/`await setTimeout(0)`, and expose progress callback `onProgress(processed, total)` consumed later by orchestration/CLI.
- [Wiki-link title resolution ambiguous] → Match case-insensitive on exact title; on duplicates pick earliest `created_time`; record unresolved count; do not block indexing on ambiguity. Future `echo-semantic-graph` can improve resolution with alias tables.
- [FTS5 trigger performance on bulk inserts] → Wrap chunk inserts in the per-note transaction; triggers fire once per statement, not per row in WAL mode. Benchmark against 1000-note synthetic vault before release.
- [Plaintext embeddings in SQLite] → Accepted (Option A); embeddings are derived from decrypted content and cannot be encrypted without user-provided key material. Documented in spec.
- [Debounce queue unbounded if user edits while offline/locked] → Bound queue with LRU eviction and log dropped ids; flush on unlock/startup via full delta scan so no note is permanently missed.
- [Concurrent indexing runs (event + manual)] → Serialize via a lightweight in-module mutex (`running: Promise<void> | null`); new requests either coalesce or queue as `pendingScope` rather than running in parallel against the single sqlite connection.

## Migration Plan

- No new migration. Schema is already at version 2; this change only writes data.
- **Deploy:** Ship `src/indexing/**` and wire into `src/plugin/runtime.ts` (`start()` initializes watcher, `stop()` disposes it). Rebuild with `npm run build`.
- **Rollback:** No DDL to revert. Rollback is deleting the plugin or clearing the index (`DELETE FROM notes` cascades). Notes in Joplin remain untouched; re-indexing from scratch is always possible.
- **Data backfill:** On first install, `onStart` triggers a one-time `indexAll` delta scan (all notes are new hashes, so full indexing occurs). Subsequent startups do a hash-compare scan only.

## Open Questions

- None — chunk size defaults (512 tokens / 2000 chars / 50 token overlap) are proposed as `echo.chunkSize` / `echo.chunkOverlap` settings; if deferred, hardcode defaults and let `echo-config-ui` add them later without changing the pipeline contract.
- Wiki-link resolution strategy for cross-notebook duplicate titles — current design picks earliest `created_time`; a future setting for disambiguation (notebook-qualified links) can be added without changing the stored edge shape.
