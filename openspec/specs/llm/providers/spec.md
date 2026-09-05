# llm/providers Specification

## Purpose

Defines the LLM provider abstraction and provides the local Ollama implementation over its OpenAI-compatible `/v1` endpoint, including a connection test command.

## Requirements

### Requirement: Provider interface
The plugin SHALL define a single provider interface exposing chat, embeddings, and extraction operations, so that later providers can be added without changing consumers.

#### Scenario: Consumers use one interface
- **WHEN** any plugin component needs LLM capabilities (chat, embeddings, extraction)
- **THEN** it interacts with a provider through the common interface, regardless of the concrete provider configured

### Requirement: Local Ollama provider
The plugin SHALL implement the provider interface against a local Ollama instance using its OpenAI-compatible `/v1` endpoint.

#### Scenario: Chat completion
- **WHEN** the plugin sends a chat request to the Ollama provider
- **THEN** the provider calls the configured base URL and returns the completion text

#### Scenario: Unreachable provider
- **WHEN** the configured Ollama endpoint is unreachable
- **THEN** the provider surfaces a clear, actionable error identifying the endpoint and failure

#### Scenario: Provider error
- **WHEN** the Ollama endpoint returns an error response
- **THEN** the provider surfaces the error details without crashing the plugin

### Requirement: Connection test command
The plugin SHALL provide a user-invocable command that verifies the configured provider is reachable and reports the result.

#### Scenario: Successful connection
- **WHEN** the user runs the connection test and the provider responds
- **THEN** the command reports success with provider details

#### Scenario: Failed connection
- **WHEN** the user runs the connection test and the provider is unreachable or returns an error
- **THEN** the command reports a clear failure message with the reason