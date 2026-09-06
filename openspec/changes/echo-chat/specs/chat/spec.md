## Purpose

Provides the chat surface where the user talks to an LLM with their notes in context: a Joplin panel with streaming conversation, per-conversation retrieval toggles, context injection within a token budget, and source citations linking responses back to notes.

## ADDED Requirements

### Requirement: Chat panel with conversation UI
The system SHALL register a chat panel in the Joplin desktop sidebar that hosts a webview conversation UI (message list, input box, streaming responses) and SHALL communicate with the plugin process via the panel message API.

#### Scenario: Chat panel registered and visible
- **WHEN** the plugin starts with the vault unlocked
- **THEN** a chat panel is registered via the Joplin panels API, can be shown and hidden from the view menu, and displays the conversation UI

#### Scenario: Conversation survives note navigation
- **WHEN** the user navigates to a different note while the chat panel is open
- **THEN** the conversation remains displayed and usable without reloading or losing messages

#### Scenario: Plugin to webview messaging
- **WHEN** the plugin produces new conversation state (tokens, status, errors)
- **THEN** the plugin pushes the state to the webview and the UI updates without the user refreshing the panel

### Requirement: Send and receive messages
The system SHALL let the user send a message and receive an assistant response rendered in the message list, with sender/role, timestamps, and ordering preserved.

#### Scenario: User message appended
- **WHEN** the user submits a message
- **THEN** a user message is appended to the conversation immediately, the input is cleared, and the UI shows a pending/streaming assistant message

#### Scenario: Empty message rejected
- **WHEN** the user attempts to send a blank or whitespace-only message
- **THEN** the plugin does not send a provider request and the UI shows the input without adding a message

### Requirement: Streaming responses with stop and regenerate
The system SHALL render assistant responses incrementally as tokens stream from the provider, SHALL allow the user to stop an in-flight generation, and SHALL allow regenerating the last assistant response.

#### Scenario: Response streams token by token
- **WHEN** the user sends a message and the provider streams a response
- **THEN** the panel appends tokens to the assistant message as they arrive without waiting for the full response to complete

#### Scenario: User stops generation
- **WHEN** the user clicks stop while a response is streaming
- **THEN** the plugin cancels the provider request, marks the partial response as complete, and the UI returns to an idle input state

#### Scenario: Regenerate last response
- **WHEN** the user clicks regenerate on the last assistant message
- **THEN** the plugin re-runs the last user message with the same conversation state (retrieval toggles, context) and replaces the previous assistant response

#### Scenario: Provider error surfaced without crash
- **WHEN** the provider returns an error or is unreachable during generation
- **THEN** the plugin surfaces a clear error in the panel and the plugin does not crash, leaving the conversation usable for retry

### Requirement: Conversation persistence
The system SHALL persist conversations so they survive plugin restart, SHALL support multiple conversations, and SHALL allow starting a new conversation.

#### Scenario: Conversations restored on restart
- **WHEN** the plugin restarts
- **THEN** prior conversations (messages in order, retrieval toggles, notes on/off state, selected model) are restored and selectable in the panel

#### Scenario: New conversation
- **WHEN** the user starts a new conversation
- **THEN** the panel presents an empty message list and the previous conversation remains available for later viewing

### Requirement: Model selection and system prompt
The system SHALL let the user select the chat model per conversation and set a system prompt that is included in the provider request.

#### Scenario: Model selection applied
- **WHEN** the user selects a different model for a conversation
- **THEN** subsequent messages in that conversation are sent to the provider with the selected model

#### Scenario: System prompt included
- **WHEN** the user sets a system prompt for a conversation
- **THEN** the prompt is included in the provider request for each message in that conversation; a default system prompt is used when none is set

### Requirement: Context injection with notes on/off toggle
The system SHALL provide a per-conversation notes on/off toggle that controls whether retrieved note context is assembled and injected into the provider request for each message, bounded by the configured token budget.

#### Scenario: Notes on injects retrieval context
- **WHEN** the user sends a message with notes enabled
- **THEN** the system runs retrieval and context assembly for the message and injects the result into the provider request, bounded by `echo.retrievalTokenBudget`

#### Scenario: Notes off sends plain prompt
- **WHEN** the user sends a message with notes disabled
- **THEN** no retrieval runs and the provider request contains only the system prompt, message history, and the current message

#### Scenario: Context truncated to token budget
- **WHEN** assembled context would exceed the configured token budget
- **THEN** the injected context is truncated to the budget and the message still completes without error

#### Scenario: Empty retrieval result
- **WHEN** retrieval returns no hits for a message with notes enabled
- **THEN** the message proceeds with no injected note context rather than failing

### Requirement: Per-conversation retrieval toggles
The system SHALL expose per-conversation toggles to enable or disable each retriever (BM25, TF-IDF, fuzzy, dense/vector, graph) plus a master graph on/off switch, applied per message.

#### Scenario: Retriever toggles applied per message
- **WHEN** the user disables a retriever for a conversation and sends a message with notes enabled
- **THEN** retrieval for that message excludes the disabled retriever and the injected context reflects only the enabled retrievers

#### Scenario: Master graph switch off excludes graph retriever
- **WHEN** the user turns the graph on/off switch off for a conversation
- **THEN** the graph retriever is excluded from context injection regardless of the per-retriever graph toggle

#### Scenario: Toggles persist per conversation
- **WHEN** the user returns to a previously saved conversation
- **THEN** the notes on/off state and retrieval toggles saved with that conversation are restored

### Requirement: History trimming within context window
The system SHALL trim conversation history when the accumulated history plus injected context would exceed the model's context window, keeping the most recent messages while always preserving the current message and system prompt.

#### Scenario: History trimmed to fit
- **WHEN** the accumulated history plus injected context would exceed the configured maximum
- **THEN** the plugin removes the oldest messages from the provider request, never the current message or system prompt, so the request fits within the window

### Requirement: Source citations in responses
The system SHALL cite the notes used as context so the user can jump from a response to the source note.

#### Scenario: Citations rendered and clickable
- **WHEN** a response is generated with notes enabled and retrieved hits were injected
- **THEN** the panel renders citations to the source notes alongside the response, and clicking a citation opens the source note in Joplin

#### Scenario: No citations when notes off or no hits
- **WHEN** a response is generated with notes disabled or with no retrieved hits
- **THEN** no citations are rendered for that response

### Requirement: Chat respects vault lock and privacy posture
The system SHALL gate chat on vault unlock and SHALL send note-derived context only to the configured LLM provider endpoint; with a local provider, note content never leaves the machine.

#### Scenario: Vault lock gates sending
- **WHEN** the vault is locked and the user attempts to send a message
- **THEN** the plugin blocks the send and surfaces that the vault must be unlocked before chatting, resuming normally once unlocked

#### Scenario: Note context sent only to configured provider
- **WHEN** a message with notes enabled is sent
- **THEN** note-derived context is sent only to the configured LLM provider endpoint and never to any other network destination; when a local provider is configured, note content never leaves the machine