## Why

A knowledge graph you can't see isn't navigable. The graph panel gives users a visual way to explore their notes and the concepts connecting them, and it demonstrates the layered-graph design directly.

## What Changes

- **Graph visualization panel** rendering `nodes`/`edges` from the index (canvas/force layout, scalable to thousands of nodes).
- **View switching**: structural-only, semantic-only, and **overlap** (both layers together, cross-layer edges) — implemented as layer filters over the shared tables.
- **Navigation**: zoom/pan, node selection, click-to-open the note in Joplin, jump-to-note search, edge-type filtering, highlighting by cluster/centrality.
- Read-only over the index; respects index freshness (reflects `index_state`).

## Capabilities

### New Capabilities
- `graph/view`: graph visualization panel with structural/semantic/overlap views, zoom/pan, selection, and jump-to-note

### Modified Capabilities
- None.

## Impact

- Consumes `schema` (layered nodes/edges) and the populated graph from `indexing` (structural) and `graph/semantic` (semantic).
- Read-only: no writes to the index.
- Overlap view depends on the layered `layer` column defined in `echo-schema`.