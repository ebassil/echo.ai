## Context

See proposal.md - Why for motivation. The chat panel is the user-facing payoff of the retrieval pipeline and knowledge graph.

Current state of the code relevant to this change:

- **Retrieval** (`src/retrieval/index.ts`): `retrieve(query, options)` runs enabled retrievers in parallel, fuses by RRF, and (optionally) reranks. `assembleContext` (`src/retrieval/context.ts`) deduplicates hits, groups per note, and truncates to `echo.retrievalTokenBudget`, producing a `ChatContext` (chunks with `noteId`, `title`, `content`, `score`) and `SearchResult[]`. `RetrieveOptions.retrievers` already filters which retrievers participate, and per-retriever enable/disable exists in `RetrievalSettings` backed by `echo.*` settings.
- **LLM provider** (`src/llm/provider.ts`): `LLMProvider.chat(messages, options)` returns a full `Promise<string>`. The Ollama provider (`src/llm/providers/ollama.ts`) POSTs to the OpenAI-compatible `/v1/chat/completions` and parses the JSON body. No streaming exists today.
- **Settings** (`src/settings/registry.ts`): registers `echo.*` keys with defaults and validation in one place; new chat settings follow the same pattern.
- **Plugin shell** (`src/plugin/runtime.ts`, `src/index.ts`): boots on startup. Joplin's panels API (`joplin.views.panels`) provides a webview with two-way `postMessage`/`onMessage` communication. No chat code exists yet.
- **Storage**: a plaintext SQLite index DB in the plugin data dir, with versioned migrations tracked in `schema_migrations`. Vault-unlock gating is a cross-cutting concern enforced by indexing/orchestration and must be reused by chat.

## Goals / Non-Goals

**Goals:**

- A streaming chat panel in Joplin with conversation persistence, stop/regenerate, per-conversation model and system-prompt selection.
- Per-conversation notes on/off and per-retriever toggles that drive context injection through the existing retrieval pipeline, bounded by the existing token budget.
- Source citations that link responses to the notes used as context.

**Non-Goals:**

- Remote provider support, tool/function calling, multi-user, mobile, or exposing chat over the loopback CLI endpoint (future work).
- Modifying the retrieval, llm/providers, settings, or schema capability specs. Chat consumes them as-is; the conversation tables introduced below are private to chat and are added via the existing migration mechanism, not as a change to the index data model.
- Automatic conversation summarization or title generation.

## Decisions

1. **Extend the provider interface with streaming (`chatStream`).** Add `chatStream(messages, options): AsyncIterable<string>` to `LLMProvider`, implemented by parsing the OpenAI-compatible SSE stream (`data:` lines, `choices[].delta.content`), with `AbortSignal` support for stop. `OllamaProvider` implements it; `chat()` stays for existing consumers (e.g., extraction). *Alternative considered:* poll for full responses — rejected for UX; *or* make `chat` itself streaming — rejected to avoid regressing non-streaming consumers. The SSE parser is a small shared helper with unit tests.

2. **Webview panel as a thin renderer with a plugin-side controller.** The panel hosts HTML/CSS/JS; the plugin owns conversation state, retrieval, and provider calls, and talks to the webview via JSON messages over `panel.postMessage`/`onMessage` (tokens, status, errors, conversation snapshots). *Alternative considered:* full-HTML re-render per token — rejected (flicker, O(n²) DOM churn). Streaming pushes incremental token messages.

3. **Conversation persistence in the SQLite index DB.** New `conversations` and `conversation_messages` tables added through the versioned migration mechanism, storing message order, role, content, retrieval toggle state, notes-on/off state, model, and timestamps. *Alternative considered:* JSON files in the plugin data dir — rejected because the project already centralizes structured persistence in SQLite with migrations, and it gives us transactional atomicity per message.

4. **Reuse the existing retrieval entry point for context injection.** Chat calls `retrieve(query, { retrievers, tokenBudget })` then `assembleContext` to obtain the deduplicated, token-budgeted `ChatContext`, renders each chunk as an injected context block, and emits `[1]…[n]` citation markers mapped to `noteId`/`title`. Per-conversation toggles map directly to `RetrieveOptions.retrievers` (already supported). *Alternative considered:* bypass retrieval and query the DB directly — rejected: duplicates fusion, dedup, and budget logic.

5. **History trimming with the existing token estimator.** Use the chars/4 estimator already in `src/retrieval/context.ts` over system prompt + injected context + history; when the total exceeds a configured max, drop the oldest messages while always keeping the current message and system prompt.

6. **New chat settings.** Register `echo.chatSystemPrompt` (default assistant prompt), `echo.chatModel` (empty → falls back to `echo.model`), and `echo.chatHistoryBudget` (context-window cap for trimming) in `src/settings/registry.ts`, following the existing registration/validation pattern.

7. **Vault gate and privacy.** Chat reuses the vault-unlock gate: sending is blocked while locked with a user-visible message. Note-derived context is sent only to the configured provider endpoint (local Ollama by default), so with the default configuration note content never leaves the machine.

8. **Citations open notes.** Clicking a citation invokes Joplin's `openItem` command with the source `noteId`.

## Risks / Trade-offs

- [SSE streaming parsing fragility across provider implementations] → Mitigation: shared, unit-tested SSE parser; fall back to buffered `chat()` if streaming errors mid-stream rather than crashing.
- [Panel webview lifecycle (reload, hide/show) can drop in-memory state] → Mitigation: persist every message and toggle change to SQLite immediately; the panel rehydrates from the DB on (re)load.
- [Abort/stop leaves a partial assistant message] → Mitigation: mark the partial message as complete (truncated) on stop, matching the spec scenario.
- [Token estimation (chars/4) is approximate] → Mitigation: consistent with the existing retrieval estimator; the budget is a soft cap, and overflow is handled by history trimming.
- [Privacy: injected notes leave the machine once a remote provider is configured] → Mitigation: default provider is local Ollama; the spec constrains sending to the configured provider endpoint only.

## Migration Plan

- A new schema migration version adds `conversations` + `conversation_messages` on startup (idempotent, tracked in `schema_migrations`).
- No existing tables change; rollback is a previous plugin version that simply ignores the new tables. No data backfill or export is required.

## Open Questions

- Whether conversations should get auto-generated titles from the first message. Deferrable without changing the specs or the task breakdown — it affects only UI polish; the schema reserves a nullable title column either way.