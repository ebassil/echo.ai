## Context

`echo-foundation` (archived) provides the plugin shell (`src/plugin/runtime.ts`), a single shared SQLite connection via `joplin.require('sqlite3')` (`src/storage/db.ts`), versioned migrations (`src/storage/migrations.ts`), and the LLM provider interface (`src/llm/provider.ts` with `src/llm/providers/ollama.ts`). `echo-schema` (archived) ships migration version 2 that creates all domain tables: `notes`, `chunks` + `chunks_fts`, `embeddings`, `nodes`/`edges` with `layer IN ('structural','semantic')` and `type IN ('link','tag','backlink','relation','mention')`, `entities`/`relations`, `index_state` (with `structural_status` + `semantic_status`), and `pipeline_runs`, plus indexes and `PRAGMA foreign_keys = ON`. `echo-indexing` lands the first real pipeline: structural indexing (`src/indexing/pipeline.ts`, `src/indexing/chunker.ts`, `src/indexing/graphWriter.ts`, `src/indexing/persist.ts`, `src/indexing/delta.ts`, `src/indexing/watch.ts`) — content-hash delta, heading-aware chunking, wiki-link/tag/backlink graph, per-note transactions, vault gating.

This change lands the second pipeline: semantic extraction. It is the sole producer of `entities`, `relations`/`relation_evidence`, and `semantic`-layer `nodes`/`edges`, and the input for downstream consumers (`echo-retrieval` graph retriever, `echo-graph-view` semantic/overlap views, `echo-orchestration` scheduling, `echo-cli` triggers). See proposal.md - Why for motivation and `specs/graph/semantic/spec.md` for normative requirements. The proposal's four clarified decisions are: (A) lazy evidence-counted cascade default with eager opt-in, (B) exact+fold and embedding-clustered canonicalization (no LLM merge), (C) per-note default extraction with parallel per-chunk add-on or per-chunk replace, chunk size configurable, (D) opt-in enrichment with idempotency marker, loop suppression, and `source='enrichment'` discriminator.

## Goals / Non-Goals

**Goals:**
- A deterministic semantic pipeline: fetch note content via `joplin.data` → choose granularity (per-note windowed vs per-chunk bounded-parallel) → call `provider.extract` with JSON schema validation and one corrective retry → canonicalize → diff evidence → write semantic layer atomically per note → update `index_state.semantic_status`
- Evidence-counted storage: `relation_evidence` join table supports lazy cascade (confidence stays coherent without re-extracting neighbors) and eager cascade has a bounded frontier (depth × fanoutCap + visited set)
- Two canonicalization modes without LLM generation: `exact` (case-fold) deterministic and free, `embedding` (cosine clustering) via local embeddings
- Optional structural enrichment that is off by default, idempotent via `<!-- echo:enrichment ... -->` marker, and does not loop through `watch.ts`
- Reuse `echo-indexing` patterns: per-note `BEGIN IMMEDIATE`/`COMMIT` transactions, chunker with `echo.chunkSize`/`echo.chunkOverlap`, vault lock gating, `pipeline_runs` logging, and scope resolution (note/folder/all)

**Non-Goals:**
- Retrieval retrievers, RRF fusion, or token-budget context assembly — that is `echo-retrieval` (this change only populates the data it will read)
- Graph visualization, view switching, or UI interaction — that is `echo-graph-view` (this change only writes `layer='semantic'` data it will read)
- Scheduling, priority queueing, or cancellation abstraction — that is `echo-orchestration` (this change exposes a trigger API that orchestration will call; it may write minimal `pipeline_runs` rows needed for status)
- Remote/secondary LLM providers — Ollama via `provider.extract`/`provider.embeddings` is already available; no new provider here
- Automatic or default-on enrichment — any write to Joplin notes requires explicit `echo.enrichmentEnabled=true`

## Decisions

### Module location: `src/semantic/`
New module `src/semantic/` exposing `extractNote`, `extractFolder`, `extractAll`, `getSemanticStatus`, and internal helpers `extractor.ts`, `canonicalize.ts`, `evidence.ts`, `cascade.ts`, `enrichment.ts`, `validate.ts`. Structural indexing stays in `src/indexing/`.
- **Why:** Mirrors capability `graph/semantic`; keeps the second pipeline isolated from `storage/`, `llm/`, and `indexing/`. Downstream changes import only the semantic service interface. Follows the same boundary as `echo-indexing`'s `src/indexing/` decision.
- **Alternative:** Extend `src/indexing/` with semantic files — couples two pipelines with different provider calls and cascade semantics. Rejected.

### Schema delta: migration version 3
Adds two DDL changes on top of version 2:
1. `relation_evidence` join table for lazy evidence counting: `CREATE TABLE relation_evidence (relation_id TEXT REFERENCES relations(id) ON DELETE CASCADE, chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, created_at TEXT, PRIMARY KEY (relation_id, chunk_id))` with indexes on `relation_id`, `chunk_id`, `note_id`. The existing `relations.evidence_chunk_id` column is retained for backwards compatibility (nullable) but new writes use the join table; a backfill or deprecation can follow.
2. `source` discriminator for enrichment: `ALTER TABLE nodes ADD COLUMN source TEXT CHECK (source IN ('joplin','enrichment')) DEFAULT 'joplin'` and same for `edges`. Existing rows default to `'joplin'`; enriched rows are inserted with `source='enrichment'`. This enables `WHERE source='enrichment'` for filtered deletes and view behavior.

Both changes are applied in a single `BEGIN`/`COMMIT` transaction via `src/storage/migrations.ts` version 3, following the `echo-schema` migration pattern. The change records `LATEST_SCHEMA_VERSION = 3`.
- **Why:** `relation_evidence` is required for A (lazy) to be coherent: single-FK `relations.evidence_chunk_id` cannot count support from multiple chunks/notes and cannot compute confidence from evidence count. `source` is required for D to distinguish enriched structural edges from user-authored edges without a new layer.
- **Alternative:** Keep `relations.evidence_chunk_id` and allow duplicate `relations` rows per (source,target,type,evidence_chunk_id) — works but makes retrieval's `SELECT DISTINCT` and confidence aggregation noisier and duplicates `relation_type` strings. Join table is more legible. Rejected as primary.
- **Alternative for source:** Encode in `nodes.id` prefix (`tag:enrichment:<slug>`) — avoids DDL but pushes complexity into every reader. Rejected.

### Extraction granularity: per-note default with bounded per-chunk options
Default path: for each note, build `fullContent = "# {title}\n\n{body}"` (as `chunker.ts:45` does), strip enrichment markers, and if `fullContent.length <= echo.extractionMaxChars` (default 8000 chars) call `provider.extract(fullContent)` once. If longer, split into `chunkNote()` windows (reusing `DEFAULT_CHUNKER_OPTIONS` and `echo.chunkSize`/`echo.chunkOverlap`) and extract each window, then merge entities/relations with deduplication before canonicalization.

Opt-in paths controlled by `echo.extractionGranularity`:
- `per-note` (default) — as above.
- `per-chunk` — skip per-note call, extract each chunk from `chunkNote()` once, `echo.extractionConcurrency` bounds parallelism (default 1, max 4 via p-limit semaphore).
- `per-note+per-chunk` — run both and merge; deduplication is by exact+fold normalized name for entities and by (source,target,type) for relations.

Chunk size is configurable via existing `echo.chunkSize`/`echo.chunkOverlap` (reused for both indexing and semantic windowing); `echo.extractionMaxChars` is the per-note window cap that triggers the windowed fallback. The design notes that `echo.semanticChunkSize` can be split out later without changing pipeline contract, as in `echo-indexing`'s open question.
- **Why:** Per-note is most faithful for cross-heading relations and cheapest (one LLM generation per note). Per-chunk hedges against context-window limits and local VRAM by bounding chunk size; parallel add-on lets users pay more LLM calls for recall. Reusing `chunker.ts` avoids duplicating markdown parsing.
- **Alternative:** Always per-chunk — simpler but loses cross-chunk relations and costs N× more LLM calls for every note. Rejected as default.
- **Alternative:** Sliding window over chunks with overlap deduplication only on overlap region — more complex, little gain over reusing `chunkNote`'s overlap.

### Extraction validation and retry
`provider.extract` in `src/llm/providers/ollama.ts:66` sends a system prompt `"Respond only with JSON {entities:[{name,type}], relations:[{from,to,type}]}"` and `parseExtraction` strips ```` ```json ```` fences then `JSON.parse`, returning `[]` on failure. Semantic pipeline wraps this with strict validation: require `entities` array where each entry has `name: string (non-empty)` and `type: string`, `relations` array where each entry has `from,to,type: string (non-empty)`. Unknown fields are ignored. On validation failure, retry once with a corrective user message: `"Your previous response was not valid JSON for the schema ... Return only the JSON."` with `temperature: 0`. If still invalid, mark `index_state.semantic_status='failed'` with `error` truncated to 1k (`persist.ts:117` pattern) and continue to next note.
- **Why:** Extraction quality is load-bearing for retrieval and graph view; silent `[]` on parse failure (current behavior) drops data without signal. One corrective retry recovers ~half of fence/format errors without looping.
- **Alternative:** No retry — simpler but more false-negative extractions, especially with smaller Ollama models. Rejected.
- **Alternative:** Heuristic JSON repair (extract JSON object via regex) — fragile, prompt retry is more reliable.

### Canonicalization: exact+fold (default) and embedding-clustered (opt-in)
Shared normalization: `normalize(name) = NFC → trim → toLocaleLowerCase() → collapse \s+ → strip leading/trailing punctuation` (same as `graphWriter.ts:88` plus `body.normalize('NFC')` from `chunker.ts:45`). In `exact` mode (`echo.canonicalizationMode='exact'`), dedupe is `Map<normalized, Entity>`: first-seen canonical wins, `aliases` is JSON array of distinct original spellings, `type`/`confidence` from first occurrence or max confidence. In `embedding` mode, after exact pre-grouping, embed each normalized name via `provider.embeddings([name])` (sequential, reuse Ollama embeddings model; `provider.embeddings` already batches in `indexing/embedder.ts` pattern), then for each incoming entity find nearest existing `entities.canonical_name` by cosine; if `cosine > echo.canonicalSimilarity` (default 0.85, range 0.70–0.95) merge (aliases union, keep earliest canonical, rewrite `nodes.entity_id` for absorbed entity), else insert new row. No LLM generation is used for canonicalization in either mode.
- **Why:** Two modes cover the cost/accuracy tradeoff the explore surfaced: `exact` is deterministic, free, and sufficient for small vaults; `embedding` catches paraphrases/abbreviations without an LLM merge. Keeping LLM out preserves the `prefer pure-JS, no native` constraint and avoids non-determinism.
- **Alternative:** LLM-based canonicalize pass ("merge these entities") — handles "NYC"↔"New York" well but adds generation cost and inconsistency. Rejected per your B decision.
- **Alternative:** Single mode only — less UI but forces users to pay embedding cost even when they don't need it. Rejected.

### Evidence handling and confidence formula
`evidence.ts` manages `relation_evidence` and `mention` bookkeeping. On per-note re-extraction: delete `relation_evidence WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)` and `edges WHERE layer='semantic' AND source_id = 'note:<id>' AND type='mention'` within the per-note transaction, then insert new evidence/edges from the merged extraction results. Confidence is deterministic: `confidence = 1 - product_i(1 - c_i)` where `c_i` is per-evidence LLM confidence (if provider returns it) or a default (e.g., 0.6) when not provided; alternatively `evidence_count`-weighted when no per-evidence confidence. If `evidence_count` drops to 0, the `relations` row and its `edges(type='relation')` are deleted. This recomputation runs on every evidence add/remove, keeping lazy cascade coherent without re-extracting neighbors.
- **Why:** `1 - product(1 - c)` grows with evidence count and saturates, matching the intuition that two independent mentions are more confident than one, without exceeding 1.0.
- **Alternative:** `avg(c_i)` — doesn't reward multiple evidence; `evidence_count / maxCount` — needs a global max. Rejected.

### Cascade engine: lazy default, eager with depth × fanoutCap + visited set
`cascade.ts` implements both modes. Lazy (`echo.semanticCascade='lazy'`): on any note's re-extraction, diff `relation_evidence`/`mentions` for that note, decrement evidence counts for relations that lost support, delete zero-evidence relations/edges, and stop — no neighbor enqueue. Eager (`echo.semanticCascade='eager'`): after re-extracting the trigger note, compute `affectedEntities = added ∪ removed ∪ typeChanged`. For each, query `SELECT DISTINCT note_id FROM relation_evidence JOIN chunks ON ... WHERE relation_id IN (relations touching affectedEntities)` plus `SELECT note_id FROM nodes WHERE entity_id IN affectedEntities` (mention neighbors), limited to `echo.semanticCascadeFanoutCap` (default 50, order by `notes.updated_at` desc to prefer recently active notes), minus `visited`. Re-extract the frontier in parallel up to `echo.extractionConcurrency`, repeat for `echo.semanticCascadeDepth` iterations (default 1). `visited` is a `Set<noteId>` for the whole cascade run. Longest chain is `depth * fanoutCap` notes; depth=1 bounds to immediate neighborhood as requested.
- **Why:** Lazy coherence without re-extraction is the cost-sensitive default; eager opt-in bounds the blowup that a popular entity would otherwise cause. Depth=1 is the minimal correctness-correct eager step (direct co-mentioners) and the natural knob for users who want stronger coherence.
- **Alternative:** Unbounded eager (recurse until no new neighbors) — could re-extract the whole vault on a single edit for a common entity. Rejected.

### Enrichment: opt-in, marker, loop suppression
`enrichment.ts` runs only when `echo.enrichmentEnabled=true` (default false). For each enriched note, it generates suggested tags (`#tag` form) and wiki-links (`[[Target]]`) from the semantic extraction output (top-confidence entities/relations whose targets resolve to existing note titles via `graphWriter.ts:88` resolution). It writes them via `joplin.data.post(['tags',...])` or `joplin.data.put(['notes',id],{body})`, appending an `<!-- echo:enrichment v1 tags=[...] links=[...] -->` HTML comment footer. The footer is stripped before chunking/extraction so it never becomes training signal. Before writing, the note id is added to an in-flight `Set` (`enrichmentInFlight`); `watch.ts`'s `createIndexingEvents` handler checks this set and skips enqueuing a reindex for that id within a 5-second suppression window, then removes it after the debounce fires. Enriched graph rows carry `source='enrichment'` so `DELETE FROM edges WHERE source='enrichment' AND source_id = 'note:<id>'` can remove enrichment without touching user-authored structural edges.
- **Why:** Opt-in and marker satisfy the "write-back is the only mutable side effect" concern from the explore; suppression prevents `enrichment → watch → reindex → re-extract → re-enrich` loop while still updating the structural graph via the direct `source='enrichment'` write.
- **Alternative:** No suppression and rely on content-hash equality to skip — works but still triggers a full read and hash compute for each enrichment, noisy for large vaults. Dedicated suppression is cleaner.
- **Alternative:** Front matter marker — collides with user front matter conventions; HTML comment at EOF is invisible in render and easy to strip.

### Pipeline integration: per-note transactions, vault gating, scopes, pipeline_runs
Each note's delete-old → extract → canonicalize → insert evidence/edges → upsert `notes`/`index_state` is wrapped in `persist.ts:9` `withPerNoteTransaction` (`BEGIN IMMEDIATE`/`COMMIT`). Vault gating mirrors `watch.ts:40` (poll `isVaultLocked()` every 3s) and `pipeline.ts:172` early return: no `joplin.data.get(body)` while locked; queued cascade frontier is deferred to unlock via `flush()` plus a full delta scan. Scope resolution reuses `indexing/scopes.ts` (`resolveScope`, `fetchNotesPaginated`) for `note`/`folder`/`all`. `pipeline_runs` logging follows `specs/schema/spec.md` `pipeline IN ('structural','semantic','embedding')`: one row per run with `trigger` (`manual`|`event`|`schedule`|`startup`), `scope`, `status`, `notes_processed`/`chunks_created`/`errors`, and a `cascade` field in `scope` JSON when eager.
- **Why:** Reuses the transaction and vault patterns already reviewed for `echo-indexing`, keeping the two pipelines consistent and minimizing new failure modes.

## Risks / Trade-offs

- [Local LLM quality variance] → Small Ollama models hallucinate entities/relations; mitigate with strict JSON schema, one corrective retry, and confidence threshold filtering before graph write; recommend an eval fixture (50 notes, manual labels) before wiring into retrieval's RRF fusion.
- [Large vault generation cost] → Semantic `indexAll` over 1000 notes × per-note extraction at ~2s/call is ~30 minutes; mitigate with per-note delta skipping (`delta.ts:22` pattern), bounded concurrency, `onProgress` callback for UI/CLI, and resume-from-failure (`semantic_status='success'` notes skipped on retry).
- [Embedding mode cost] → Embedding every normalized entity name costs embedding calls proportional to unique entities; mitigate by exact pre-grouping and batching via `provider.embeddings` (batch 32 as in `indexing/embedder.ts`), caching entity name → vector in memory for the run.
- [Cascade fanout on popular entities] → "Project X" mentioned in 100 notes could trigger fanoutCap neighbor writes per edit; mitigate with `echo.semanticCascadeFanoutCap=50` and depth=1 default, and single `pipeline_runs` row so history isn't noisy.
- [FTS and cascade interaction] → Cascade does not touch `chunks_fts` (only semantic tables), but evidence deletes cascade via `chunks` FK; ensure `relation_evidence.note_id` is indexed for fast neighbor lookup and that evidence deletions are indexed by `chunk_id`.
- [Enrichment marker drift] → Users editing the marker manually could create parse errors; mitigate by tolerant parsing (ignore malformed marker, treat as absent) and never including marker in extraction input.
- [Dual pipelines competing for Ollama VRAM] → Structural embeddings and semantic extraction could overlap if `watch.ts` triggers both; serialize via `pipeline.ts:259` `indexWithMutex` style mutex or a shared work queue with priority; detail the queuing owned by `echo-orchestration` but ensure semantic does not starve structural.

## Migration Plan

- Adds migration version 3 to `src/storage/migrations.ts` containing `relation_evidence` create and `nodes`/`edges` `source` columns, plus indexes. On startup, `applyMigrations` applies it if `schema_migrations` is at version 2; existing DBs upgrade cleanly, fresh DBs go 1→2→3 atomically.
- No change to `notes`/`chunks`/`chunks_fts`/`embeddings`/`index_state` columns except `source` additions; `index_state.semantic_status` already exists.
- **Deploy:** Ship with plugin build; existing users with version 2 DBs auto-migrate on next launch. Semantic tables are empty until `extractAll` or per-note extraction runs.
- **Rollback:** No downgrade migration; rollback is `DELETE FROM nodes WHERE layer='semantic'` + `DELETE FROM relation_evidence` + `DELETE FROM relations` + `DELETE FROM entities` + `DELETE FROM edges WHERE layer='semantic'` + `DROP TABLE IF EXISTS relation_evidence` (or just delete the DB file; re-extraction from Joplin notes is always possible). Enriched rows can be rolled back with `DELETE FROM edges WHERE source='enrichment'` without affecting user data.
- **Data backfill:** On first semantic install, `onStart` triggers a one-time `extractAll` delta scan (all notes are `semantic_status='pending'`, so full extraction occurs). Subsequent startups do hash-compare delta only.

## Open Questions

- None — confidence formula is specified as `1 - product(1 - c_i)` (with default 0.6 when provider omits per-evidence confidence); if evaluator prefers a simpler `evidence_count`-weighted average, it can replace the implementation without changing the spec's evidence-counting contract or the task breakdown. Layering of `relation_type` ontology (open vocabulary vs curated enum) is deferred to a future catalog change without changing the stored edge shape.
