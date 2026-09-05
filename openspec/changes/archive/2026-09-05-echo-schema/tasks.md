## 1. Schema Migration

- [x] 1.1 Add migration version 2 to `src/storage/migrations.ts` creating all domain tables (`notes`, `chunks`, `embeddings`, `nodes`, `edges`, `entities`, `relations`, `index_state`, `pipeline_runs`) with columns, CHECK constraints, and foreign keys per specs/schema/spec.md
- [x] 1.2 Add FTS5 virtual table `chunks_fts` (external content mode) and triggers (`chunks_ai`, `chunks_ad`, `chunks_au`) synchronized with `chunks`
- [x] 1.3 Add indexes for delta tracking, graph traversal, and layer/type filtering (`notes(content_hash)`, `chunks(note_id, chunk_index)`, `edges(source_id)`, `edges(target_id)`, `edges(layer, type)`, `nodes(layer)`, `pipeline_runs(pipeline, started_at)`, `index_state(updated_at)`)
- [x] 1.4 Ensure `PRAGMA foreign_keys = ON` is set on database open and migration is applied atomically in a transaction with version recorded in `schema_migrations`
- [x] 1.5 Verify `npm run build` succeeds and manually test migration on a fresh in-memory SQLite DB (tables exist, CHECK/UNIQUE/FK constraints enforced, FTS5 triggers fire, idempotent re-apply)
