## 1. Provider Streaming

- [x] 1.1 Add `chatStream(messages, options): AsyncIterable<string>` to the `LLMProvider` interface in `src/llm/provider.ts`, with `ChatOptions` extended by `signal?: AbortSignal` for cancellation
- [x] 1.2 Implement a shared SSE parser helper (`src/llm/sse.ts`) that reads `data:` lines from the OpenAI-compatible stream, extracts `choices[].delta.content`, yields string deltas, and stops at `[DONE]`
- [x] 1.3 Implement `chatStream` on `OllamaProvider` (`src/llm/providers/ollama.ts`) by POSTing to `/v1/chat/completions` with `stream: true`, wiring the abort signal to the fetch, and yielding deltas; keep `chat()` unchanged for existing consumers
- [x] 1.4 Add unit tests for the SSE parser (delta chunks, `[DONE]`, malformed lines ignored) and for `chatStream` against a mocked fetch (token sequence, abort mid-stream, provider error thrown)

## 2. Chat Settings

- [x] 2.1 Register `echo.chatSystemPrompt` (default echo assistant prompt), `echo.chatModel` (empty string → falls back to `echo.model`), and `echo.chatHistoryBudget` (context-window cap, e.g. default 8000) in `src/settings/registry.ts` following the existing registration/validation pattern
- [x] 2.2 Add validation for the new keys in `validateSettings` and `loadSettings` (retain-prior-on-invalid for `echo.chatHistoryBudget`), and add them to the `watchSettings` change detection
- [x] 2.3 Add a `ChatSettings` resolution helper (`src/chat/settings.ts`) that reads the chat keys and resolves `chatModel` fallback to the global model, returning a typed object

## 3. Schema and Conversation Persistence

- [x] 3.1 Add a new schema migration version creating `conversations` (id, title nullable, model, system_prompt, notes_on, retrieval_toggles JSON, created_at, updated_at) and `conversation_messages` (id, conversation_id FK ON DELETE CASCADE, role, content, citations JSON, created_at, seq) in the schema package, idempotent via `schema_migrations`
- [x] 3.2 Implement a conversation repository (`src/chat/store.ts`) with create/list/get/delete conversation, append message, save toggles/system prompt, and rehydrate a conversation's full message list ordered by `seq`
- [x] 3.3 Add unit tests for the repository (create+append+rehydrate round-trip, cascade delete, toggle persistence, empty conversation)

## 4. Chat Controller

- [x] 4.1 Implement `src/chat/controller.ts` holding per-conversation state (messages, notesOn, retrievalToggles, model, systemPrompt, streaming state, AbortController)
- [x] 4.2 Implement the send path: append user message, build the provider request (system prompt + trimmed history + current message), and route through streaming with per-token emission; persist each message after completion
- [x] 4.3 Implement context injection: when notesOn, call `retrieve(message, { retrievers, tokenBudget })` + `assembleContext` and render the resulting `ChatContext` chunks as injected context blocks with `[1]…[n]` citation markers mapped to `noteId`/`title`; send only provider request when notes off; proceed with no context on empty results
- [x] 4.4 Apply per-conversation retrieval toggles to `RetrieveOptions.retrievers`, including the master graph on/off switch that forces graph off regardless of its per-retriever toggle
- [x] 4.5 Implement history trimming using the chars/4 estimator over system prompt + injected context + history against `echo.chatHistoryBudget`, dropping oldest messages but never the current message or system prompt
- [x] 4.6 Implement stop (abort the in-flight `chatStream`, mark the partial assistant message complete) and regenerate (re-run the last user message with the same conversation state, replacing the previous assistant response)
- [x] 4.7 Add unit tests for the controller with a fake provider and fake retrieval: notes on/off, token-budget truncation, toggle application, history trimming, stop leaves partial message, regenerate replaces response, provider error surfaces without crash

## 5. Panel Webview

- [x] 5.1 Create `src/chat/panel.ts` that registers a Joplin panel (`joplin.views.panels.create('echo.chat')`), sets the webview HTML, and wires `onMessage`/`postMessage` JSON protocol (init, send, stop, regenerate, toggles, select conversation, new conversation, open citation)
- [x] 5.2 Build the panel UI assets (HTML/CSS/JS) with a message list, streaming token rendering, input box, notes on/off switch, per-retriever toggles, model/system-prompt selectors, conversation list, and stop/regenerate controls
- [x] 5.3 Implement citation rendering and click-to-open: clicking a citation calls Joplin's `openItem` command with the source noteId
- [x] 5.4 Wire panel lifecycle: create/show panel on startup, rehydrate the active conversation from the repository on load, persist toggle changes immediately, and push incremental token/status/error updates to the webview
- [x] 5.5 Add a smoke test that drives the message protocol with a stub webview (send → tokens delivered → stop → regenerate), verifying messages round-trip and state persists

## 6. Vault Gate and Privacy

- [x] 6.1 Gate sending on vault-unlock state (reuse the existing vault-gate helper): block send while locked with a user-visible message pushed to the panel, and resume normally once unlocked
- [x] 6.2 Verify privacy posture: note-derived context is sent only to the configured provider endpoint; add a test asserting no network calls beyond the configured provider when a message with notes on is sent

## 7. Integration and Verification

- [x] 7.1 Wire the chat panel into `src/plugin/runtime.ts`: `onStart` registers the panel and controller, `onStop` tears down listeners and aborts any in-flight stream
- [x] 7.2 Run the build (`npm run dist`) and fix any TypeScript/webpack issues; run the full test suite
- [ ] 7.3 Manual verification checklist against the spec scenarios: streaming render, stop, regenerate, conversation restore on restart, model/system prompt applied, notes on/off, per-retriever and graph toggles, citations open notes, vault-lock block, provider error surface