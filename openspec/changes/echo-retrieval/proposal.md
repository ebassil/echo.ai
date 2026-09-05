## Why

Chat with note context and note search both need to pull the *right* chunks from the index. A single retrieval strategy misses too much; composing several retrievers (sparse, dense, fuzzy, graph) and fusing them gives robust results.

## What Changes

- **Retriever interface**: `retrieve(query, options)` returning ranked chunk/document hits.
- **Retriever implementations**:
  - BM25 via the FTS5 table,
  - TF-IDF computed over the chunk corpus,
  - fuzzy (trigram FTS5 / title edit-distance),
  - dense (embedding kNN over stored vectors),
  - graph (entity match on the query + neighborhood expansion into connected notes).
- **Fusion**: reciprocal rank fusion (RRF) of enabled retrievers, with optional reranking.
- **Context assembly**: dedupe, token-budget truncation, ordering, and source attribution; produce both structured context (for chat) and result lists (for search UI).
- Per-retriever enable/disable knobs surfaced as settings (these are the user-facing toggles from the product vision).

## Capabilities

### New Capabilities
- `retrieval`: parallel retrievers (BM25, TF-IDF, fuzzy, dense, graph), RRF fusion, context assembly with token budgeting

### Modified Capabilities
- None.

## Impact

- Consumes `schema` (chunks, FTS, embeddings, graph tables), `indexing`/`graph/semantic` (populated data), and `llm/providers` (query embedding).
- Consumed by `echo-chat` (context injection) and `echo-config-ui` (search UI).
- Retrieval toggles defined here become the settings that `echo-config-ui` renders and `echo-chat` applies per message.