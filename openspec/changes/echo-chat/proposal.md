## Why

The product vision centers on chatting with your notes. The chat panel is where the user talks to the LLM and where the retrieval pipeline and knowledge graph earn their keep by being injected into context.

## What Changes

- **Chat panel** (webview) with conversation UI: message list, streaming responses, stop/regenerate, conversation persistence.
- **Context injection pipeline**: a per-conversation toggle for *notes on/off*; when on, run retrieval and context assembly for each message and inject the result into the prompt within the token budget.
- **Retrieval toggles**: per-retriever enable/disable (graph, vector, BM25, TF-IDF, fuzzy) and a graph on/off switch, applied per message.
- Provider streaming over the `llm/providers` interface; model selection; system prompt; history trimming.
- Source citations: retrieved notes are linked/cited in responses so the user can jump to them.
- Privacy: with a local provider, note content never leaves the machine.

## Capabilities

### New Capabilities
- `chat`: chat panel, streaming conversation, context injection with notes on/off and retrieval toggles, source citations

### Modified Capabilities
- None.

## Impact

- Consumes `retrieval` (context assembly), `llm/providers` (chat streaming), and `schema`/`indexing` (note metadata for citations).
- Consumed by nothing downstream; it is the user-facing payoff.
- Depends on `echo-retrieval` being complete (change 7).