## Purpose

Owns the echo.ai index database: SQLite initialization, versioned migrations, and connection management used by every later pipeline.

## ADDED Requirements

### Requirement: Index database initialization
The plugin SHALL create and open the SQLite index database in the plugin data directory on first startup.

#### Scenario: Fresh database
- **WHEN** the plugin starts and no index database exists
- **THEN** the plugin creates the SQLite database file in the plugin data directory

#### Scenario: Existing database
- **WHEN** the plugin starts and an index database already exists
- **THEN** the plugin opens the existing database without recreating it

### Requirement: Versioned migrations
The plugin SHALL track schema versions in a `schema_migrations` table and SHALL apply pending migrations in order on startup.

#### Scenario: Apply pending migrations
- **WHEN** the database is at a version older than the latest schema version
- **THEN** the plugin applies each pending migration in order and records the resulting version

#### Scenario: No pending migrations
- **WHEN** the database is already at the latest schema version
- **THEN** the plugin skips migration and opens the database normally

#### Scenario: Migration failure
- **WHEN** a migration fails to apply
- **THEN** the plugin aborts startup with a user-visible error and leaves the database in a recoverable state

### Requirement: Index database is local and unsynced
The index database SHALL live only in the plugin data directory and SHALL NOT be synced by Joplin.

#### Scenario: Database location
- **WHEN** the plugin creates the index database
- **THEN** the database file resides under the plugin data directory, outside any synced note folders

### Requirement: Database connection management
The plugin SHALL expose a single shared connection to the index database for the plugin's lifetime and SHALL close it on shutdown.

#### Scenario: Shared access
- **WHEN** multiple plugin components request the index database
- **THEN** they SHALL share the plugin's managed connection rather than opening independent connections

#### Scenario: Close on shutdown
- **WHEN** the plugin stops
- **THEN** the plugin closes the index database connection and releases the file handle