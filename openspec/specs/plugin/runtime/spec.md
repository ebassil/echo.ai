# plugin/runtime Specification

## Purpose

Provides the echo.ai plugin shell: a runnable Joplin desktop plugin that boots on startup, owns a plugin data directory, and registers its lifecycle and command surface.

## Requirements

### Requirement: Plugin boots on startup
The plugin SHALL register with Joplin's plugin API and complete its startup sequence when the application launches.

#### Scenario: Successful startup
- **WHEN** Joplin desktop starts with the plugin enabled
- **THEN** the plugin's `onStart` lifecycle hook runs without error and the plugin is active

#### Scenario: Startup failure
- **WHEN** the plugin fails during startup (for example, storage or settings fail to initialize)
- **THEN** the plugin SHALL report a user-visible error and shut down cleanly without corrupting existing data

### Requirement: Plugin data directory
The plugin SHALL resolve and create a dedicated data directory under Joplin's plugin data root, and SHALL fail fast with a clear message if it cannot be created.

#### Scenario: Data directory creation
- **WHEN** the plugin starts and the data directory does not exist
- **THEN** the plugin creates the directory and exposes its path to the rest of the plugin

#### Scenario: Data directory already exists
- **WHEN** the plugin starts and the data directory already exists
- **THEN** the plugin reuses the existing directory without error

### Requirement: Plugin shuts down cleanly
The plugin SHALL release resources (open database handles, active network requests) when Joplin stops the plugin.

#### Scenario: Normal shutdown
- **WHEN** Joplin stops the plugin
- **THEN** the `onStop` lifecycle hook runs, open resources are released, and shutdown completes without error

### Requirement: Command registration skeleton
The plugin SHALL register its commands (for example, the connection test command) so they are invocable from the Joplin command palette.

#### Scenario: Command is invocable
- **WHEN** the user invokes a registered echo command from the command palette
- **THEN** the plugin executes the command handler and surfaces the result to the user