# Changelog

All notable changes to this project are documented here.

## [Unreleased] - 2026-03-17

### Added

- Added `raid` (optional) support in `/list add` for both blacklist and whitelist.
- Added predefined raid choices: `Act4 Nor`, `Act4 Hard`, `Kazeros Nor`, `Kazeros Hard`, `Mordum Hard`.
- Added owner metadata for list entries: `addedByUserId`, `addedByTag`.
- Added `allCharacters` roster snapshot storage to detect matches across the same roster.
- Added `/list remove` flow with 3 options when a name exists in both lists (black/white/both).
- Added `/listcheck` command to check multiple character names against blacklist/whitelist in one request.

### Changed

- Refactored list commands: replaced the old flow with `/list add` and `/list remove`.
- Updated roster checks to compare against DB list collections and provide clearer output.
- Updated notification/image behavior to prioritize cleaner evidence image display in replies.
- Updated `/listcheck` output format to a single combined list with status icons and a hard limit of 7 names per command.

### Fixed

- Fixed class mapping issue (`class breaker`) in roster/suggestion processing.
- Improved error messages when roster is not found and similar-name suggestions are available.

### Documentation

- Updated `.env.example` with required environment variables for local run and deployment.