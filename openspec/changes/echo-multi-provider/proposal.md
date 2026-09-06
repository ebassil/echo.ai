## Why

The plugin is locked to a single Ollama provider. Users want to mix local inference engines (Ollama, vLLM, LM Studio, llama.cpp) and cloud OpenAI-compatible services (DeepSeek, Groq, OpenRouter, Together, OpenAI) — and they want to define the model catalog themselves, not consume a hardcoded list. The existing `LLMProvider` abstraction already targets "remote OpenAI-compatible later," so this change fulfills that intent.

## What Changes

- **User-configured model catalog**: replace the scalar `echo.provider` / `echo.baseUrl` / `echo.model` settings with a list of model entries (add + / remove −). Each entry holds its own provider type, base URL, API key, model name, and optional display name.
- **Multi-provider support**: the provider factory accepts any registered provider type (`ollama`, `vllm`, `lm-studio`, `llama-cpp`, `openai`, `deepseek`, `groq`, `openrouter`, `together`, `custom`). `custom` covers any unlisted OpenAI-compatible endpoint with no default base URL and optional auth.
- **Single `OpenAICompatibleProvider` implementation**: all supported types share one OpenAI-compatible `/v1` transport (`chat`, `chatStream`, `embeddings`, `listModels`, `extract`, `testConnection`), with optional `Authorization: Bearer` from the entry's API key. The Ollama-specific provider class is subsumed by it.
- **Encrypted API keys**: each model entry carries its own API key, stored via Joplin's encrypted settings (`setEncryptedValue`). Keys are shown only for provider types that require auth.
- **Chat panel model dropdown**: the dropdown lists all configured models (display name, falling back to `providerType / model`). Selecting one drives the chat request for that conversation.
- **Migrate existing settings**: on first run after upgrade, the legacy `echo.provider`/`echo.baseUrl`/`echo.model` values become the first catalog entry. Legacy keys are deprecated but retained for migration.
- **Connection test per entry**: `testConnection` operates on the selected model entry.
- **BREAKING** for consumers of `registry.ts` provider settings: `echo.provider`, `echo.baseUrl`, `echo.model` are replaced by the catalog.
- **Aligns `echo-config-ui`**: its "LLM provider + models" section renders and edits this catalog rather than defining its own provider settings.

## Capabilities

### New Capabilities
- `model-catalog`: user-managed list of model entries — add/remove, per-entry provider type + base URL + API key + model name + display name, migration from legacy settings, encrypted key storage, and the canonical source of display names consumed by the chat panel.

### Modified Capabilities
- `llm/providers`: requirement changes from "local Ollama provider" to a generic OpenAI-compatible provider instantiated per catalog entry, with optional bearer auth and multi-type factory dispatch.
- `settings`: the settings surface changes from scalar provider/base URL/model keys to the model catalog (`echo.models` JSON) plus the pre-existing pipeline keys; legacy keys are deprecated.

## Impact

- **Breaks**: `src/settings/registry.ts` PROVIDER_OPTIONS / validator, `src/llm/factory.ts`, `src/llm/providers/ollama.ts` (replaced), anything reading `echo.provider`/`echo.baseUrl`/`echo.model` (semantic extraction, chat settings, health, runtime provider construction).
- **Consumers adapt**: `src/plugin/runtime.ts`, `src/chat/settings.ts`, `src/llm/health.ts` (probe per entry), `src/retrieval/index.ts` (rerank gate can no longer key off a single hardcoded `name === 'ollama'`).
- **Dependencies**: Joplin encrypted settings API for API keys; existing settings watch/validate machinery; no new npm packages (pure JS transport already in use).
- **Security posture**: unchanged — per entry, note-derived context is sent only to that entry's configured endpoint; API keys are stored encrypted by Joplin, never logged.
- **Sequence**: prerequisite/parallel to `echo-config-ui`, which will render this catalog.