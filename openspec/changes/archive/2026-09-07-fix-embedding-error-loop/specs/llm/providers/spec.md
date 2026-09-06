## MODIFIED Requirements

### Requirement: Provider interface
The plugin SHALL define a single provider interface exposing chat, embeddings, and extraction operations, plus a lightweight reachability probe, so that later providers can be added without changing consumers.

#### Scenario: Consumers use one interface
- **WHEN** any plugin component needs LLM capabilities (chat, embeddings, extraction)
- **THEN** it interacts with a provider through the common interface, regardless of the concrete provider configured

#### Scenario: Reachability probe
- **WHEN** the provider health gate checks whether the provider is reachable
- **THEN** the provider exposes a non-blocking probe (reusing `listModels`, e.g. `GET {baseUrl}/v1/models` with a short timeout) that returns reachability without performing a full embedding or chat request

#### Scenario: Unreachable provider
- **WHEN** the configured Ollama endpoint is unreachable and any provider operation is attempted without going through the health gate
- **THEN** the provider surfaces a clear, actionable error identifying the endpoint and failure, and the health gate caches the `down` state so consumers defer subsequent requests