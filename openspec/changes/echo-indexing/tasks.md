## 1. Scaffolding and Utilities

- [x] 1.1 Create `src/indexing/hash.ts` — SHA-256 of normalized `title + '\n' + body` (NFC), used for `notes.content_hash` / `index_state.content_hash` delta
- [x] 1.2 Create `src/indexing/markdown.ts` — strip YAML front matter, parse markdown headings and fences (pure-JS parser), extract raw text sections
- [x] 1.3 Create `src/indexing/chunker.ts` — heading-aware chunking with configurable max size (default ~512 tokens / ~2000 chars) and overlap (~50 tokens); deterministic `(note_id, chunk_index)` → `chunk.id`; compute `token_count`

## 2. Structural Extraction and Graph Writing

- [x] 2.1 Create `src/indexing/extractors/links.ts` — parse `[[Target]]` / `[[Target|alias]]` wiki-links from note body, return link targets with unresolved tracking
- [x] 2.2 Create `src/indexing/extractors/tags.ts` — fetch tags for a note via `joplin.data` (`joplin.data.get(['notes', id, 'tags'])` or equivalent), return tag records
- [x] 2.3 Create `src/indexing/graphWriter.ts` — upsert `nodes` row per note (`layer='structural', kind='note'`), scoped delete + insert `edges` (`type='link'/'tag'/'backlink'`, `layer='structural'`) for a source note; resolve wiki-link titles to note ids (case-insensitive exact match, earliest `created_time` on duplicates)

## 3. Embedding and Persistence

- [x] 3.1 Create `src/indexing/embedder.ts` — batch `provider.embeddings(texts)` (default batch 32, sequential), serialize Float32 → BLOB, handle provider errors per batch, return vectors with `model`/`dims`
- [x] 3.2 Create `src/indexing/delta.ts` — read `index_state.content_hash` per note, compare to new hash, decide skip/reprocess; on reprocess atomically delete stale chunks/embeddings (FK CASCADE + `chunks_fts` triggers) and scoped structural edges; support `force` bypass
- [x] 3.3 Create `src/indexing/persist.ts` (or fold into `delta.ts`) — per-note transaction (`BEGIN IMMEDIATE`/`COMMIT`): delete old → insert `chunks` → call embedder + insert `embeddings` → graphWriter → upsert `notes` snapshot (`title`, `notebook_id`, `notebook_name`, `content_hash`, `parent_id`, `created_at`, `updated_at`, `indexed_at`, `status`) → upsert `index_state` (`content_hash`, `structural_status`, `last_indexed_at`, `error`, `updated_at`); rollback on failure with `failed` status

## 4. Scopes and Orchestration

- [x] 4.1 Create `src/indexing/scopes.ts` — resolve scopes to `noteId[]`: single note (direct fetch), folder (BFS descendant folders via `joplin.data.get(['folders'])` then paginated note fetches), all notes (paginated `joplin.data.get(['notes'])` with field projection)
- [x] 4.2 Create `src/indexing/pipeline.ts` — `indexNote(noteId)`, `indexFolder(folderId)`, `indexAll(options?)` sharing one engine: paginated fetch → hash → delta → chunk → embed → graph → persist; yield per page (`setImmediate`/`await setTimeout(0)`); return `{ notesProcessed, chunksCreated, skipped, errors }`; serialize concurrent runs via in-module mutex/queue coalescing
- [x] 4.3 Wire `src/indexing/events.ts` and `src/indexing/watch.ts` — register `joplin.workspace.onNoteChange` (or data-API fallback), debounce (default ~1200 ms, coalesce per `noteId`), enqueue `indexNote` on added/changed, purge on deleted; queue events while vault is locked and flush on unlock/next delta scan; bounded deduped in-memory queue

## 5. Integration and Lifecycle

- [x] 5.1 Wire into `src/plugin/runtime.ts` — initialize indexing watcher after DB open in `start()`, dispose on `stop()`; expose `getIndexingService()` or similar for downstream consumers (`echo-semantic-graph`, `echo-orchestration`, `echo-cli`); ensure `PRAGMA foreign_keys = ON` is in effect for all indexing writes
- [x] 5.2 Handle vault lock/unlock gate — detect locked state, defer indexing while locked (no decrypted reads), run debounced delta catch-up scan on unlock/startup; surface pause status to callers
- [x] 5.3 Add settings keys (if not deferred to `echo-config-ui`) — `echo.chunkSize`, `echo.chunkOverlap`, `echo.embeddingBatchSize` with defaults and validation; otherwise hardcode defaults with TODO for settings wiring

## 6. Verification

- [x] 6.1 Add unit tests for `chunker.ts` (heading splits, size limits, overlap, single-chunk small notes, code-fence handling), `hash.ts` determinism, `delta.ts` hash-compare + stale purge, and `extractors/links.ts` wiki-link parsing
- [x] 6.2 Add integration tests on a temp SQLite DB (via `src/storage/db.ts` helpers or in-memory `sqlite3`) — run `pipeline.indexAll` on synthetic notes, assert `chunks`/`chunks_fts`/`embeddings`/`nodes`/`edges`/`notes`/`index_state` state, verify FTS triggers fire and FK CASCADE deletes embeddings on note purge
- [x] 6.3 Manual validation — `npm run build` succeeds, plugin starts in Joplin desktop, edit a note → observe debounced reindex (log or status), check folder/all scopes, verify deleted note is purged and hash-equal notes are skipped; `npm test` (or `npm run test`) passes
