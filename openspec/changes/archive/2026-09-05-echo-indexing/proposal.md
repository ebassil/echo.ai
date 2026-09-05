## Why

Chat context and graph retrieval both depend on a populated structural index. Without it, nothing downstream (retrieval, graph view, chat) has data to work with.

## What Changes

- **Structural pipeline**: pull notes via `joplin.data`, parse Markdown, split into chunks (heading-aware with size limits), extract wiki-links, tags, and backlinks, and write **structural-layer** nodes/edges into the layered graph.
- **Embedding pipeline**: embed chunks through the provider embedding model and store vectors in `embeddings`.
- **Content-hash delta**: only reprocess notes whose content hash changed; remove stale chunks/edges on deletion.
- **Scopes**: reindex a single note, a folder, or all notes.
- **Event watching**: react to note added/change/deleted events, debounced, run after vault unlock; track per-note state in `index_state`.
- Correctly handles the encryption reality: reads decrypted content via the API only while the vault is unlocked.

## Capabilities

### New Capabilities
- `indexing`: structural indexing pipeline — chunking, link/tag/backlink extraction, structural graph edges, chunk embeddings, content-hash delta, scoped runs, event-driven watching

### Modified Capabilities
- None.

## Impact

- Consumes `schema` (tables), `storage`, and `llm/providers` (embeddings) from earlier changes.
- Consumed by `echo-semantic-graph` (feeds note/chunk input), `echo-retrieval`, `echo-orchestration` (scheduling this pipeline), and `echo-graph-view` (structural layer data).
- Performance sensitive: embedding thousands of notes is the dominant cost; delta processing is the mitigation.