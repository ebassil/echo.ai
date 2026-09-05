## 1. Scaffolding and Interfaces

- [x] 1.1 Create `src/retrieval/` module skeleton with barrel exports and `types.ts` defining `Hit` (`chunkId?`, `noteId`, `title`, `content`, `score`), `Retriever` (`{ id, enabled, retrieve(query, opts): Promise<Hit[]> }`), `RetrieveOptions` (`{ retrievers?, limit, perNoteLimit?, tokenBudget? }`), and `FusedResult`
- [x] 1.2 Define `RetrieveContext`/deps wiring: shared DB handle, LLM provider (`provider.embeddings`), and settings accessor passed to all retrievers and assembly
- [x] 1.3 Add `src/retrieval/settings.ts` registering `echo.*` settings: `echo.retrievalRetrievers` (JSON enable map), `echo.retrievalDenseK`, `echo.retrievalTokenBudget` (default 4000), `echo.retrievalMaxChunksPerNote` (default 3), `echo.retrievalRrfK` (default 60), `echo.retrievalRerankEnabled`, `echo.retrievalRerankModel`, all validated with retain-prior-on-invalid

## 2. BM25 Retriever

- [x] 2.1 Implement `src/retrieval/bm25.ts` querying `chunks_fts` with `MATCH` + `ORDER BY bm25(chunks_fts)` and `snippet()` for display text, mapping rows to `Hit` (chunkId, noteId, title, content, score)
- [x] 2.2 Implement FTS5 query-term sanitization: quote/combine terms safely and fall back to a phrase match on syntax errors instead of propagating
- [x] 2.3 Add unit tests: top-ranked chunks returned, non-matching chunks excluded, `limit` respected, syntax-error fallback

## 3. TF-IDF Retriever

- [x] 3.1 Implement `src/retrieval/tfidf.ts` tokenizing `chunks.content`, building a cached DF map (invalidated on chunk-count change), computing query TF-IDF, and scoring chunks by cosine similarity with a candidate cutoff
- [x] 3.2 Add unit tests: cosine ranking over a small corpus, DF cache invalidation on corpus change, empty index returns empty

## 4. Fuzzy Retriever

- [x] 4.1 Implement `src/retrieval/fuzzy.ts` trigram FTS5 matching over note titles (fallback to bounded scan if trigram FTS5 unsupported), ranking candidates by Damerau-Levenshtein edit-distance on title
- [x] 4.2 Add unit tests: typo-tolerant title match, edit-distance ordering of multiple near matches

## 5. Dense Retriever

- [x] 5.1 Implement `src/retrieval/dense.ts` embedding the query via `provider.embeddings`, reading `embeddings` vectors, skipping dimension-mismatched rows, and ranking by cosine distance for the top `k`
- [x] 5.2 Implement graceful degradation: empty results when no embeddings exist or provider unreachable, without throwing
- [x] 5.3 Add unit tests: kNN ranking over stored vectors, dim-mismatch skip, empty/missing-embeddings behavior

## 6. Graph Retriever

- [x] 6.1 Implement `src/retrieval/graph.ts` matching query terms against `nodes.label`, BFS-expanding through `edges` with `layer` filtering (`structural` | `semantic` | both), aggregating reachable `note` nodes ranked by edge weight and hop distance
- [x] 6.2 Add unit tests: entity-label match returns connected notes, layer filtering, no-match returns empty

## 7. Fusion (RRF) and Rerank Hook

- [x] 7.1 Implement `src/retrieval/fusion.ts` RRF scoring (`1/(k+rank)` per enabled retriever, merged by chunk/note id) and a `Reranker` interface with a default identity implementation
- [x] 7.2 Add unit tests: RRF combines multiple rankings, disabled retrievers excluded, empty retriever sets fuse to empty, optional rerank reorders top set

## 8. Context Assembly

- [x] 8.1 Implement `src/retrieval/context.ts` deduplicating hits (by chunk id, then note id), grouping by note with per-note cap (`echo.retrievalMaxChunksPerNote`), ordering by fused rank, and truncating by token budget (`chunks.token_count` or JS estimator)
- [x] 8.2 Implement `buildChatContext()` (structured ordered chunks with source attribution) and `buildSearchResults()` (ranked list with noteId, title, chunk text, score, contributing retrievers)
- [x] 8.3 Add unit tests: dedupe across retrievers, per-note cap, token-budget truncation, both output shapes

## 9. Facade and Integration

- [x] 9.1 Implement `src/retrieval/index.ts` `retrieve(query, options)` facade: resolve enabled retrievers from settings, run them in parallel, fuse, and assemble; expose `buildChatContext` / `buildSearchResults`
- [x] 9.2 Add integration test: seeded chunks/embeddings/graph produce fused ranked results end-to-end; disabled retriever excluded; empty index returns empty
- [x] 9.3 Verify local-first/plaintext posture: retrieval reads only the plugin-data-dir SQLite and calls only the local provider for query embeddings; no sync, no network exfiltration; no decrypted reads while vault is locked (retrieval is only invoked when unlocked)