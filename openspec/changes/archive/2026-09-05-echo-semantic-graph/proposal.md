## Why

Keyword and vector search only find notes that already look like the query. A knowledge graph of extracted entities and relations lets the LLM find conceptually connected notes — the "bridging" insight that makes echo.ai different from existing Joplin AI plugins.

## What Changes

- **Semantic extraction pipeline**: run a local LLM over note chunks to extract entities and typed relations; write entity nodes, relation edges, and note→entity mention edges into the **semantic layer**.
- **Entity canonicalization**: deduplicate and merge entity spellings (canonical name, aliases), store confidence scores.
- **Efficient delta rebuild**: re-extract only notes whose content hash changed; diff the graph (add/remove nodes/edges); **cascade** to notes whose neighborhood changed so relation confidence stays coherent.
- **Optional structural enrichment**: as an opt-in setting, write suggested tags and wiki-links back into Joplin notes, enriching the structural layer from semantic output.
- Configurable extraction model, batch concurrency, and retry/rate handling for the local LLM.
- Privacy posture: extraction runs against the local Ollama provider; note content is never sent to a remote endpoint.

## Capabilities

### New Capabilities
- `graph/semantic`: local-LLM entity/relation extraction, entity canonicalization, delta re-extraction with cascade, optional structural enrichment

### Modified Capabilities
- None.

## Impact

- Consumes `schema` (nodes/edges/entities/relations), `indexing` (chunks as extraction input), and `llm/providers` (extraction).
- Consumed by `echo-retrieval` (graph retriever), `echo-graph-view` (semantic layer), `echo-orchestration` (scheduling), and `echo-cli`.
- Delta cascade is the correctness-critical piece: graph must not go stale when one note's entities change.