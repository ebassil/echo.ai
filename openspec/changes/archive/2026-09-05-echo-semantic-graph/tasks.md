## 1. Schema migration and evidence infrastructure

- [x] 1.1 Add migration version 3 to `src/storage/migrations.ts` creating `relation_evidence(relation_id, chunk_id, note_id, created_at, PRIMARY KEY(relation_id, chunk_id))` with `FOREIGN KEY` references, indexes on `relation_id`, `chunk_id`, `note_id`, and `ALTER TABLE nodes/edges ADD COLUMN source TEXT CHECK(source IN ('joplin','enrichment')) DEFAULT 'joplin'`, verified inside a `BEGIN`/`COMMIT` transaction
- [x] 1.2 Add migration rollback note and update `LATEST_SCHEMA_VERSION` to 3, verify fresh DB (1→2→3) and upgrade DB (2→3) both apply cleanly and re-apply is idempotent
- [x] 1.3 Create `src/semantic/evidence.ts` helpers: add/remove `relation_evidence` rows, recompute `relations.confidence` via `1 - product(1 - c_i)` with default `0.6` when provider omits per-evidence confidence, delete zero-evidence relations and their `edges(type='relation')`, and scoped delete for a note's evidence/mention edges

## 2. Extraction pipeline and validation

- [x] 2.1 Create `src/semantic/extractor.ts` wrapping `provider.extract`: build per-note full content (`"# title\n\n{body}"` with enrichment marker stripped), implement per-note windowed fallback when `fullContent.length > echo.extractionMaxChars`, and per-chunk paths (`per-chunk` skip per-note, `per-note+per-chunk` merge) with deduplication
- [x] 2.2 Create `src/semantic/validate.ts` with strict JSON schema check (entities `[{name:non-empty, type:string}]`, relations `[{from,to,type: non-empty}]`), strip ```` ```json ```` fences, and one corrective retry with a fix prompt at `temperature:0`; on persistent failure surface structured error for `index_state.error`
- [x] 2.3 Implement bounded concurrency for per-chunk extraction (`echo.extractionConcurrency`, default 1, max 4) using a semaphore/p-limit, sequential batches to avoid Ollama VRAM contention, matching `indexing/embedder.ts` posture
- [x] 2.4 Wire `src/llm/provider.ts` `ExtractionResult` to carry optional per-entity/relation confidence when provider returns it, and map it through extractor to `evidence.ts` for confidence recomputation

## 3. Entity canonicalization

- [x] 3.1 Create `src/semantic/canonicalize.ts` shared normalization `normalize(name) = NFC → trim → toLocaleLowerCase() → collapse whitespace → strip punctuation`, unit-tested against `graphWriter.ts` and `chunker.ts` normalization
- [x] 3.2 Implement `exact` mode: `Map<normalized, Entity>` with first-seen canonical wins, `aliases` JSON array of distinct originals, `type`/`confidence` from first or max, `INSERT … ON CONFLICT(canonical_name)` merge, and `nodes(entity)` bridge rows with `entity_id` rewrite for absorbed ids
- [x] 3.3 Implement `embedding` mode: after exact pre-grouping, embed normalized names via `provider.embeddings` (batched, sequential, cached per run), cosine similarity search against existing `entities.canonical_name`, merge when `> echo.canonicalSimilarity` (default 0.85), otherwise insert new entity; verify merge rewrites `nodes.entity_id` and unions aliases
- [x] 3.4 Ensure pure-JS constraint holds (no new native deps) and `entities.canonical_name UNIQUE` merge path is idempotent within `withPerNoteTransaction`

## 4. Delta, persistence, and index_state

- [x] 4.1 Extend `src/indexing/delta.ts` pattern for semantic: `shouldReprocessSemantic(db, noteId, currentHash, {force, expectedExtractionModel})` checking `index_state.content_hash`, `semantic_status`, and recorded extraction model; wire model-change invalidation (`echo.extractionModel` or `echo.model` fallback)
- [x] 4.2 Implement per-note semantic persistence in `src/semantic/persist.ts` (or reuse `src/indexing/persist.ts`): `withPerNoteTransaction` per note doing `DELETE` old evidence/mention edges for that note → insert entities/relations/evidence → materialize `nodes(layer='semantic', kind='entity')` and `edges(type='relation'|'mention')` → `upsertIndexState` with `semantic_status`/`error`/`last_indexed_at`, leaving `structural_status` untouched
- [x] 4.3 Ensure `isVaultLocked()` gating (reuse `src/indexing/vault.ts`): no `joplin.data.get(body)` or `provider.extract` while locked; queue remaining notes for unlock flush, mirrored from `watch.ts:40`/`pipeline.ts:172`

## 5. Cascade engine

- [x] 5.1 Create `src/semantic/cascade.ts` with lazy mode: after re-extracting trigger note, diff its `relation_evidence`/`mentions`, decrement evidence counts for affected relations, delete zero-evidence relations/edges, update confidence, and do not enqueue neighbors
- [x] 5.2 Implement eager mode: from `affectedEntities` (added/removed/typeChanged) query neighbor `note_id`s from `relation_evidence` and `nodes(entity_id)` limited to `echo.semanticCascadeFanoutCap` (default 50, ordered by `notes.updated_at` desc), minus `visited` set, re-extract frontier up to `echo.extractionConcurrency` parallel, iterate for `echo.semanticCascadeDepth` (default 1)
- [x] 5.3 Add cascade-mode resolution: `echo.semanticCascade` (`lazy`|`eager` default `lazy`), `echo.semanticCascadeDepth`, `echo.semanticCascadeFanoutCap`, plus per-run override `{mode, depth}` from orchestration/CLI; verify `visited` prevents loops and fanout cap guarantees `≤ depth * fanoutCap` notes processed
- [x] 5.4 Ensure single `pipeline_runs` row per cascade run (`pipeline='semantic'`, `trigger` from event/manual/schedule, `scope` JSON encoding cascade mode+depth, `notes_processed = 1 + cascadedCount`, `error` truncated to 1k)

## 6. Scoped runs and pipeline integration

- [x] 6.1 Implement `src/semantic/index.ts` scoped runners `extractNote(noteId)`, `extractFolder(folderId)`, `extractAll()` reusing `src/indexing/scopes.ts` `resolveScope`/`fetchNotesPaginated` and `pipeline.ts:259` `indexWithMutex`-style serialization for the semantic pipeline
- [x] 6.2 Add pagination, `onProgress` callback, and `IndexResult`-style counts (`notesProcessed`, `entitiesCreated`, `relationsCreated`, `skipped`, `errors`) plus `indexWithMutex` coalescing for concurrent semantic triggers
- [x] 6.3 Integrate vault watch: reuse `src/indexing/watch.ts` debounce and `wasLocked`/`flush()` unlock flush so cascade frontier defers while locked and resumes on unlock/startup catch-up

## 7. Optional structural enrichment

- [x] 7.1 Create `src/semantic/enrichment.ts` behind `echo.enrichmentEnabled=false` (default off): generate suggested tags (`#tag`) and wiki-links (`[[Target]]`) from top-confidence semantic entities/relations that resolve via `graphWriter.ts` title resolution, write via `joplin.data.post`/`put`
- [x] 7.2 Implement idempotency marker: append/update `<!-- echo:enrichment v1 ... -->` HTML footer not included in chunking/extraction, parse marker on re-run to diff and write only added/removed enrichment, treat missing/malformed marker as not-yet-enriched
- [x] 7.3 Implement loop suppression: `enrichmentInFlight: Set<noteId>` registered before `joplin.data.put`, checked in `watch.ts`/`events.ts` debounce handler to skip re-enqueue within 5s window, then removed after debounce fires; enriched graph rows carry `source='enrichment'` so `DELETE FROM edges WHERE source='enrichment'` can remove enrichment without touching `source='joplin'` edges
- [x] 7.4 Ensure enrichment never sends note content to network (only local Ollama call for extraction) and marker is stripped from extraction input

## 8. Settings and configuration

- [x] 8.1 Register settings in `src/settings/registry.ts`: `echo.canonicalizationMode` (`exact`|`embedding` default `exact`), `echo.canonicalSimilarity` (0.70-0.95 default 0.85), `echo.extractionGranularity` (`per-note`|`per-chunk`|`per-note+per-chunk` default `per-note`), `echo.extractionConcurrency` (1-4 default 1), `echo.extractionMaxChars` (1000-20000 default 8000), `echo.extractionModel` (string, optional, fallback `echo.model`), `echo.semanticCascade` (`lazy`|`eager`), `echo.semanticCascadeDepth` (1-5 default 1), `echo.semanticCascadeFanoutCap` (10-200 default 50), `echo.enrichmentEnabled` (bool default false), plus validation in `validateSettings`
- [x] 8.2 Add `isValid` helpers and `resolveSettings` merging for new keys, and ensure `DEFAULT_SETTINGS` includes sensible defaults without breaking existing settings UX

## 9. Testing and verification

- [x] 9.1 Add unit tests for normalization (NFC, case-fold, whitespace, punctuation), `exact` dedupe, `embedding` cosine merge threshold, `validate.ts` retry, and confidence `1 - product(1 - c)` recomputation on evidence add/remove
- [x] 9.2 Add integration tests with in-memory SQLite: per-note delta skip, hash-change re-extract, deleted note purge (evidence count decrements, zero-evidence relation deleted), lazy cascade (neighbor not re-extracted, confidence drops), eager cascade (depth=1 frontier re-extracted, visited caps fanout), and enrichment marker idempotency + `source='enrichment'` filtering
- [x] 9.3 Add vault-locked test (no extraction while locked, deferred queue flushed on unlock) and scope tests for note/folder/all with `pipeline_runs` row assertions
- [x] 9.4 Manual QA: build plugin (`npm run build`), verify Joplin loads settings section, run semantic extraction on a 20-note fixture with `exact` and `embedding` modes, toggle `per-chunk`/`per-note+per-chunk`, trigger eager cascade via manual call, enable enrichment and verify marker + loop suppression, and confirm retrieval/graph-view can query `layer='semantic'` and `source='enrichment'`
