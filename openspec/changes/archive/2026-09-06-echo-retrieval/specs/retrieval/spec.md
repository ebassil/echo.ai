# retrieval Specification

## Purpose

Provides echo's composable retrieval pipeline: parallel sparse, dense, fuzzy, and graph retrievers fused by reciprocal rank fusion (RRF), assembled into deduplicated, token-budgeted context for chat and ranked result lists for search.

## ADDED Requirements

### Requirement: Retriever interface with ranked results
The system SHALL expose a retriever interface `retrieve(query, options)` that accepts a query string and options (retriever selection, result limit, per-note grouping) and returns ranked hits, where each hit identifies a chunk (or note) with a relevance score and the source note.

#### Scenario: Retrieval returns ranked hits
- **WHEN** `retrieve(query, options)` is called against a populated index
- **THEN** it returns an ordered list of hits, each with a chunk identifier (or note identifier), a relevance score, and the originating note id

#### Scenario: Empty index returns empty result
- **WHEN** `retrieve` is called on an index with no chunks
- **THEN** it returns an empty result list without error

#### Scenario: Result limit respected
- **WHEN** `retrieve` is called with a `limit` option
- **THEN** the returned hit list contains no more than `limit` hits

### Requirement: BM25 retriever via FTS5
The system SHALL provide a BM25 retriever that queries the `chunks_fts` FTS5 virtual table using the `bm25()` ranking function over the chunk corpus.

#### Scenario: BM25 returns top matching chunks
- **WHEN** a query is run through the BM25 retriever over the `chunks_fts` table
- **THEN** it returns the top chunks ranked by BM25 score, each with its note id, and chunks with no term match are excluded

#### Scenario: Query term filtering and snippet
- **WHEN** the BM25 retriever runs a query with multiple terms
- **THEN** the FTS5 query is constructed to match chunks containing the terms, and each returned chunk can be rendered with a short matched-text snippet for display

### Requirement: TF-IDF retriever over chunk corpus
The system SHALL provide a TF-IDF retriever that computes term weights over the stored chunk corpus and scores chunks by cosine similarity of query and chunk term vectors.

#### Scenario: TF-IDF ranks chunks by cosine similarity
- **WHEN** a query is run through the TF-IDF retriever
- **THEN** it tokenizes the query, scores each chunk by cosine similarity of TF-IDF vectors computed over the corpus, and returns the top chunks with their scores

#### Scenario: Corpus derived from stored chunks
- **WHEN** the TF-IDF retriever builds its term weights
- **THEN** it derives document frequencies from the `chunks` table content so results reflect the current index without a separate persisted corpus

### Requirement: Fuzzy retriever for approximate title and text match
The system SHALL provide a fuzzy retriever that surfaces chunks and notes whose title or content approximately matches the query, using trigram-based FTS5 matching and title edit-distance.

#### Scenario: Fuzzy match on title with typos
- **WHEN** a query approximately matches a note title (e.g., a misspelled title) via trigram FTS5
- **THEN** the fuzzy retriever returns the matching note and its chunks ranked by similarity

#### Scenario: Title edit-distance ordering
- **WHEN** multiple note titles approximately match the query
- **THEN** the fuzzy retriever orders them by title edit-distance, with the closest match ranked first

### Requirement: Dense retriever via embedding kNN
The system SHALL provide a dense retriever that embeds the query with the configured LLM provider and performs a k-nearest-neighbor search over stored chunk vectors in the `embeddings` table.

#### Scenario: Dense kNN over stored vectors
- **WHEN** the dense retriever runs a query and the index contains embeddings
- **THEN** it embeds the query via the LLM provider and returns the nearest chunk vectors ranked by similarity (cosine distance), each with its note id

#### Scenario: Dense retriever handles missing embeddings
- **WHEN** the dense retriever runs but no embeddings exist for the index (or the embedding provider is unreachable)
- **THEN** it returns an empty result set for dense hits without failing the overall retrieval, and reports the retriever as unavailable

#### Scenario: Embedding dimension compatibility
- **WHEN** query and stored embeddings have different dimensions
- **THEN** the dense retriever skips vectors whose dimension does not match the query embedding rather than returning incorrect results

### Requirement: Graph retriever via entity match and neighborhood expansion
The system SHALL provide a graph retriever that matches query terms/entities against graph node labels and expands to connected notes through `nodes` and `edges`, supporting both `structural` and `semantic` layers.

#### Scenario: Entity match returns connected notes
- **WHEN** a query term matches a node label in the graph
- **THEN** the graph retriever returns the notes connected to that node via outgoing edges, ranked by edge weight and hop distance

#### Scenario: Layer-filtered expansion
- **WHEN** the graph retriever is configured for a specific layer (`structural`, `semantic`, or both)
- **THEN** it expands only through edges of the selected layer(s)

#### Scenario: No graph match returns empty
- **WHEN** no node label matches the query terms
- **THEN** the graph retriever returns an empty result set without failing the overall retrieval

### Requirement: Reciprocal rank fusion of enabled retrievers
The system SHALL fuse the ranked results of all enabled retrievers using reciprocal rank fusion (RRF), producing a single combined ranking, and SHALL support optional reranking of the fused top set.

#### Scenario: RRF combines retriever rankings
- **WHEN** two or more retrievers return rankings for the same query
- **THEN** the system computes an RRF score for each hit across retrievers and returns a single combined ranking, with hits appearing in multiple retriever result sets promoted by the fusion

#### Scenario: Disabled retrievers excluded from fusion
- **WHEN** one or more retrievers are disabled via settings
- **THEN** only enabled retrievers contribute results to the fusion, and no error is raised for disabled retrievers

#### Scenario: Optional reranking of fused top set
- **WHEN** reranking is enabled and a reranker is configured
- **THEN** the system reorders the top fused hits based on reranker scores before returning them

#### Scenario: Fusion over empty retriever sets
- **WHEN** all enabled retrievers return empty result sets
- **THEN** the fusion returns an empty combined result

### Requirement: Context assembly with token budget and source attribution
The system SHALL assemble retrieval hits into context: deduplicate hits across notes, truncate to a configured token budget with per-note ordering, and produce both a structured chat-context payload and a ranked result list for search UI, each with source attribution.

#### Scenario: Deduplicated assembly within token budget
- **WHEN** hits reference overlapping or duplicate chunks across retrievers
- **THEN** the system deduplicates them, orders by fused rank, and truncates the assembled set so total tokens do not exceed the configured `echo.retrievalTokenBudget`

#### Scenario: Structured chat context output
- **WHEN** chat requests retrieval context
- **THEN** the system returns a structured payload containing ordered chunks (title, note id, content, source attribution) bounded by the token budget, suitable for injection into a chat prompt

#### Scenario: Ranked result list for search UI
- **WHEN** the search UI requests results
- **THEN** the system returns a ranked list of hits with note id, title, chunk text, score, and contributing retrievers for display

#### Scenario: Per-note ordering and grouping
- **WHEN** assembling context with a per-note limit
- **THEN** the system groups hits by note and limits chunks contributed per note so a single note cannot monopolize the budget

### Requirement: Retrieval settings
The system SHALL expose settings to enable/disable each retriever (BM25, TF-IDF, fuzzy, dense, graph), configure the dense model/k, the fusion parameters, the token budget, and reranking, all persisted as `echo.*` settings and surfaced to UI.

#### Scenario: Per-retriever enable/disable knobs
- **WHEN** the user toggles a retriever's setting in the config UI
- **THEN** the corresponding retriever is enabled or excluded from future retrieval runs, persisted as an `echo.*` setting

#### Scenario: Token budget and k configuration
- **WHEN** the user changes `echo.retrievalTokenBudget`, dense `k`, or fusion parameters
- **THEN** subsequent retrieval runs use the updated values without a database migration

#### Scenario: Settings validated with retain-prior-on-invalid
- **WHEN** the user enters an invalid value (e.g., non-numeric token budget or negative k)
- **THEN** the system rejects the value and retains the prior valid setting
