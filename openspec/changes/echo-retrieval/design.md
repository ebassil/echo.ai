## Context

`echo-schema` (archived) ships the domain tables retrieval reads: `chunks` + `chunks_fts` (FTS5 external-content, BM25), `embeddings` (chunk_id, model, dims, vector BLOB), and the layered graph (`nodes`, `edges`, `entities`, `relations`). `echo-indexing` (archived) populates chunks/embeddings via `src/indexing/` (chunker, embedder, graphWriter). `echo-semantic-graph` (archived) populates semantic entity/relation nodes. The LLM provider (`src/llm/provider.ts`) exposes `provider.embeddings` for query embedding.

No retrieval code exists yet. Downstream consumers (`echo-chat`, `echo-config-ui`) will call a single retrieval facade, and per-retriever toggles defined here become the `echo.*` settings those UIs render.

See proposal.md - Why for motivation and `specs/retrieval/spec.md` for normative requirements.

## Goals / Non-Goals

**Goals:**
- A single retrieval facade (`retrieve(query, options)`) that composes parallel retrievers and returns fused, ranked hits
- Five retrievers over existing tables: BM25 (FTS5), TF-IDF (corpus over `chunks`), fuzzy (trigram FTS5 + title edit-distance), dense (embedding kNN), graph (node-label match + neighborhood expansion)
- RRF fusion with optional reranking hook
- Context assembly: dedupe, per-note grouping, token-budget truncation, and both chat-context and search-result outputs with source attribution
- `echo.*` settings for per-retriever enable/disable, k, token budget, and fusion/rerank config

**Non-Goals:**
- New DDL — retrieval reads existing schema tables only
- New LLM provider implementations — reuse `provider.embeddings` for dense query vectors
- Reranker model implementation — only a pluggable interface; concrete rerankers are deferred (see Open Questions)
- Chat prompt construction or graph view rendering — those belong to `echo-chat` / `echo-graph-view`

## Decisions

### Module location: `src/retrieval/`
New module `src/retrieval/` with: `index.ts` (facade), `types.ts` (Hit, Retriever, RetrieveOptions, FusedResult), `bm25.ts`, `tfidf.ts`, `fuzzy.ts`, `dense.ts`, `graph.ts`, `fusion.ts` (RRF + rerank hook), `context.ts` (assembly/token budget), `settings.ts`.

- **Why:** Mirrors capability `retrieval` and isolates each retriever the way `indexing` and `semantic` are isolated. Downstream consumers import only `retrieval/index.ts` + `types.ts`.
- **Alternative:** Fold retrievers into `src/indexing/` — couples read-side retrieval to write-side indexing and makes chat/search depend on a pipeline module. Rejected.

### Shared retriever contract and ranked hits
`types.ts` defines `Retriever = { id: 'bm25'|'tfidf'|'fuzzy'|'dense'|'graph'; enabled: boolean; retrieve(query, opts): Promise<Hit[]> }` where `Hit = { chunkId?: string; noteId: string; title: string; content: string; score: number }`. Each retriever returns its own ranking; fusion reconciles them. Retrievers are constructed in `index.ts` from settings and the shared DB handle + provider.

- **Why:** A uniform `Hit` shape lets fusion and context assembly ignore which retriever produced a hit and makes adding a retriever a one-file change.
- **Alternative:** Per-retriever result types mapped later — more coupling in fusion and context. Rejected.

### BM25 via FTS5 `bm25()` and snippet
`bm25.ts` runs `SELECT ... FROM chunks JOIN chunks_fts ON chunks.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?` (with `snippet()` for display text). Query terms are sanitized to valid FTS5 syntax (basic `AND`/phrase handling, quoted fallback on syntax errors).

- **Why:** Direct use of the existing `chunks_fts` virtual table; `bm25()` is the standard SQLite ranking and needs no external dependency.
- **Alternative:** Precompute IDF + hand-rolled BM25 in JS — duplicates what FTS5 already provides. Rejected.

### TF-IDF computed on demand over `chunks`
`tfidf.ts` builds document frequencies by scanning `chunks.content` (word-tokenized), computes query TF-IDF, and scores each chunk by cosine similarity. Results are bounded by a candidate cutoff to avoid scoring the whole corpus every query; the DF map is cached and invalidated on chunk-count change.

- **Why:** No new table (spec requires corpus derived from stored chunks). Caching bounds cost on repeated queries.
- **Trade-off:** Cold-start scan is O(corpus) on first query; accepted for local single-user use.

### Fuzzy via trigram FTS5 + title edit-distance
`fuzzy.ts` maintains a lightweight trigram FTS5 query over `chunks` titles (and content) using `LIKE`/`GLOB`-style matching or a dedicated trigram FTS5 tokenizer where available, then orders candidates by Damerau-Levenshtein edit-distance on the title. If FTS5 trigram support is unavailable, falls back to a bounded scan with edit-distance ranking.

- **Why:** Approximate title match (typo tolerance) without a native module; pure-SQLite + pure-JS edit-distance fits the "prefer pure-JS" constraint.
- **Alternative:** Bundle a JS fuzzy-search library — an extra dependency for a case FTS5 trigrams cover adequately. Rejected.

### Dense kNN over `embeddings`
`dense.ts` embeds the query once via `provider.embeddings` (local Ollama), reads stored vectors from `embeddings`, and ranks by cosine distance. Dimension-mismatched rows are skipped. Missing embeddings or unreachable provider returns empty (marked unavailable) rather than failing fusion. A flat scan over the BLOB vectors is used (index is local and modest); a real ANN index is a future optimization.

- **Why:** Correct, dependency-free kNN over the existing `embeddings` table; graceful degradation matches the spec.
- **Trade-off:** O(n) scan per query — fine at local scale; revisit with an ANN library only if latency demands it.
- **Alternative:** Bundle an ANN index (e.g., hnswlib native) — violates the "prefer pure-JS / no native modules" constraint. Rejected for now.

### Graph retrieval: node-label match + neighborhood expansion
`graph.ts` matches query terms against `nodes.label` (via FTS/`LIKE` over node labels), collects matched node ids, then BFS-expands through `edges` (respecting selected `layer`), aggregating reachable `note` nodes. Rank by edge weight and hop distance (shorter hops and higher weights first). Returns note/chunk hits.

- **Why:** Reuses the layered `nodes`/`edges` tables and gives semantic + structural expansion as specified.
- **Alternative:** Expand on entities only (semantic) — misses structural wiki-link/tag/backlink reachability. Rejected; layer selection covers both.

### RRF fusion with pluggable rerank hook
`fusion.ts` computes RRF: `score(hit) = Σ 1/(k + rank_retriever(hit))` (k default 60) over enabled retrievers, merging by chunk/note id. A `Reranker` interface (`rerank(hits, query): Promise<Hit[]>`) is invoked when enabled; the default is identity (no rerank).

- **Why:** RRF is simple, robust, and rank-only (no score normalization needed across heterogeneous retrievers). The interface decouples fusion from any concrete reranker.
- **Alternative:** Weighted score fusion (e.g., normalized scores) — sensitive to each retriever's score distribution; RRF avoids that. Rejected.

### Context assembly: dedupe, per-note grouping, token budget
`context.ts` takes fused hits, dedupes (by chunk id, then by note id for note-level hits), groups by note with a per-note chunk cap (`echo.retrievalMaxChunksPerNote`), orders by fused rank, and truncates by cumulative token count (approximated via `token_count` column or a JS estimator) up to `echo.retrievalTokenBudget`. It emits both `buildChatContext()` (structured ordered chunks with source attribution) and `buildSearchResults()` (ranked list with score and contributing retrievers).

- **Why:** Single assembly path shared by chat and search; token budgeting keeps chat prompts within the model context window.
- **Alternative:** Separate chat and search assemblies — duplicates dedupe/truncation logic. Rejected.

### Settings: per-retriever enable, k, budget, fusion, rerank
`settings.ts` registers `echo.*` settings: `echo.retrievalRetrievers` (object/JSON of booleans per retriever id), `echo.retrievalDenseK`, `echo.retrievalTokenBudget` (default e.g. 4000), `echo.retrievalMaxChunksPerNote` (default e.g. 3), `echo.retrievalRrfK` (default 60), and `echo.retrievalRerank` (enabled + model). All validated with retain-prior-on-invalid (consistent with existing settings behavior).

- **Why:** These toggles are the user-facing knobs the product vision and `echo-config-ui` render; `echo-chat` applies them per message.
- **Trade-off:** `echo.retrievalRetrievers` as a JSON blob is less granular in the settings UI than individual keys; acceptable as the single grouped knob and simpler to render as checkboxes.

## Risks / Trade-offs

- [Dense kNN is O(n) per query] → Mitigation: cache the query embedding, skip dim-mismatch rows; local single-user index scale; revisit ANN only if latency measured as a problem.
- [TF-IDF cold-start corpus scan cost] → Mitigation: cache DF map keyed on chunk count; invalidate on change; candidate cutoff.
- [FTS5 `MATCH` syntax errors from user query] → Mitigation: sanitize/quote query terms and fall back to a safe phrase match rather than propagating syntax errors.
- [Retrievers failing independently (provider down, empty index)] → Mitigation: each retriever degrades to empty + `unavailable` flag; fusion over empty sets returns empty, never throws.
- [Token-budget estimator approximate] → Mitigation: use `chunks.token_count` where present; fall back to a deterministic JS estimator; documented as approximate.

## Migration Plan

Deploy as part of the next plugin release: add `src/retrieval/` and register settings; no schema migration (reads existing tables). Rollback: remove the facade/settings; consumers (`echo-chat`, `echo-config-ui`) land in later changes, so nothing else breaks if this change is reverted. No data migration required.

## Open Questions

- Which concrete reranker to wire when reranking is enabled (e.g., an LLM listwise rerank via the local provider) — deferred; the interface is in place and a default identity reranker ships now.
- Whether `echo.retrievalRetrievers` should later be split into individual settings keys — deferred to `echo-config-ui` work.
