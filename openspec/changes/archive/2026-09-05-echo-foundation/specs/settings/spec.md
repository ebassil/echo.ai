## Purpose

Registers and manages the echo.ai settings surface: the `echo.*` settings keys, their defaults, and their validation.

## ADDED Requirements

### Requirement: Settings section registration
The plugin SHALL register an `echo.*` settings section visible in Joplin's options, grouping the provider, base URL, and model selection keys.

#### Scenario: Settings visible
- **WHEN** the user opens Joplin options
- **THEN** an echo settings section is present containing the provider, base URL, and model selection settings

#### Scenario: Settings persisted
- **WHEN** the user changes an echo setting and closes options
- **THEN** the value is persisted by Joplin and restored on the next startup

### Requirement: Default values
The plugin SHALL provide sensible defaults for every registered echo setting, including a default provider and base URL.

#### Scenario: Defaults applied
- **WHEN** the plugin starts and a user has never configured a given echo setting
- **THEN** the setting resolves to its documented default value

### Requirement: Settings validation
The plugin SHALL validate echo settings values (for example, a well-formed base URL and a non-empty model name) and SHALL reject invalid values with a user-visible message.

#### Scenario: Invalid base URL
- **WHEN** the user sets an echo base URL that is not a valid HTTP(S) URL
- **THEN** the plugin reports the invalid value and does not use it

#### Scenario: Valid values accepted
- **WHEN** the user sets a valid base URL and model name
- **THEN** the plugin accepts and uses the values