# provider-health Specification

## Purpose

Defines a cached provider reachability gate that lets the plugin distinguish "the LLM provider is down" from "this note failed" — preventing endless retry loops and error storms when the local Ollama endpoint is unreachable.

## Requirements

### Requirement: Provider health gate with cached reachability status
The system SHALL maintain a cached reachability status for the configured LLM provider, probed lazily with a short timeout and a TTL, so consumers decide whether to issue embedding/extraction requests without hammering a dead endpoint.

#### Scenario: Cached status avoids repeated probes
- **WHEN** the provider health gate is asked for status and the cached value is within its TTL
- **THEN** the gate returns the cached status without issuing any network request

#### Scenario: Probe on expiry with short timeout
- **WHEN** the cached status has expired or no probe has run yet
- **THEN** the gate probes the provider (`GET {baseUrl}/v1/models`) with a short timeout (<=2s), records the outcome, and returns `up` or `down`

#### Scenario: Down-state recovers quickly
- **WHEN** the provider is unreachable and the gate caches `down`
- **THEN** the down-state TTL is short (e.g., 15s) so a restarted Ollama is detected within one probe window without manual action

#### Scenario: Cache invalidation
- **WHEN** provider settings change (`baseUrl`, `model`) or a manual connection test runs
- **THEN** the gate drops its cached status so the next check re-probes the provider

### Requirement: Consumers consult the health gate
The system SHALL gate embedding and extraction work behind the health gate so that an unreachable provider defers work instead of issuing per-note failed requests.

#### Scenario: Indexing defers embeddings when provider down
- **WHEN** the structural indexing pipeline would embed chunks but the health gate reports the provider `down`
- **THEN** the pipeline does not call `provider.embeddings`, leaves the affected notes' existing chunks and embeddings intact, records a consolidated "provider unreachable — indexing deferred" status, and does not mark per-note failures

#### Scenario: Manual runs proceed with guarded embedding
- **WHEN** a manual or forced run executes while the provider is `down`
- **THEN** the run proceeds for structural-only work but skips embedding calls for notes, leaving those notes `pending` rather than `failed`

#### Scenario: Recovery resumes automatically
- **WHEN** the health gate transitions from `down` to `up` and an automatic indexing run starts
- **THEN** pending notes are re-embedded on the next delta pass without user action
