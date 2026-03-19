# Changelog

All notable changes to this project are documented here.

## [Unreleased] - 2026-03-19

### Added

- Added image-based `/listcheck` flow using Gemini OCR input.
- Added Gemini model failover support via `GEMINI_MODELS` priority list.
- Added approver-ID workflow for `/list add` proposals (DM Approve/Reject buttons).
- Added hardcoded approver routing with one random officer plus always-on senior approver.
- Added requester preview embed for submitted `/list add` proposals.
- Added synchronized DM state updates across approvers during approval processing.
- Added auto-approve path when requester is an officer or senior approver ID.
- Added `addedByDisplayName` support for better creator display in list/roster results.

### Changed

- Refactored bot architecture from monolithic `bot.js` into modular handlers/services/utils.
- Changed `/listcheck` to image-driven checking with a hard limit of 8 names.
- Changed `/listcheck` output to always include reason details when available.
- Changed roster output lines to include class info (`Name · Class · ilvl · power`).
- Changed list add requester notification flow to reply in the original request channel context when possible.
- Changed maintenance logic to fixed weekly window: Wednesday 07:00 UTC to Thursday 07:00 UTC.
- Changed monitor scheduler behavior to execute status checks only during maintenance window ticks.

### Fixed

- Fixed Discord interaction timeout issues on approval buttons by acknowledging interactions immediately.
- Fixed duplicate-click behavior by disabling approval buttons and showing processing state.
- Fixed OCR extraction prompt for diacritic-sensitive names (`ë`, `ö`, `ü`).
- Fixed approval UX so both approver DM messages reflect processing/final state consistently.

### Documentation

- Updated README command behavior notes for `/list add` approval flow and image-based `/listcheck`.

## [2026-03-17]

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
- Updated `/listcheck` fallback behavior: names not in both lists are validated against lostark.bible, showing `❓` when roster exists and `No roster found: <name>` when it does not.

### Fixed

- Fixed class mapping issue (`class breaker`) in roster/suggestion processing.
- Improved error messages when roster is not found and similar-name suggestions are available.

### Documentation

- Updated `.env.example` with required environment variables for local run and deployment.