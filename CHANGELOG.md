# Changelog

All notable changes to this project are documented here.

## [v0.4.0] - 2026-03-28

### Added

- Added Quick Add from auto-check — dropdown to select unflagged names → Modal (type/reason/raid) → add to list directly from check results.
- Added `/lastats` command — shows list counts, cache stats, server count, and bot uptime.
- Added `/roster deep:true` option — runs Stronghold alt detection scan even when roster is visible.
- Added `/lasetup` command for per-guild channel configuration (requires Manage Server permission):
  - `/lasetup autochannel #channel` — set auto-check channel for this server
  - `/lasetup notifychannel #channel` — set list notification channel for this server
  - `/lasetup view` — view current channel configuration (shows DB config vs env fallback)
- Added `GuildConfig` MongoDB model — stores per-guild `autoCheckChannelId` and `listNotifyChannelId`.
- Added `/lasetup reset` — clears guild config and reverts to env var fallback.
- Added bot permission check before saving channel config — verifies View Channel, Send Messages, Read Message History.
- Added test message after channel setup — bot sends a confirmation message (auto-deletes after 30s) to verify it works.
- Added `/lasetup` to `/lahelp` command listing.
- Added `RosterCache` model — caches roster check results in MongoDB (TTL 24h) to avoid repeated lostark.bible requests for the same character.
- Added smart ScraperAPI fallback cache — remembers Cloudflare blocks for 5 minutes, skips wasted direct fetch attempts.
- Added progress message during auto-check — bot replies "Checking X name(s)..." immediately after OCR, then edits with final results.
- Added Gemini non-JSON response failover — tries next model instead of throwing immediately.
- Added 404 to Gemini model failover conditions — non-existent models gracefully fall through.
- Added Gemini thinking parts filter — excludes `thought: true` parts from response text.
- Fixed lostark.bible search API payload format (`[1,2]` → `{"name":1,"region":2}`).
- Fixed Gemini default model list — corrected `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview` names.
- Roster checks in auto-check/listcheck now run sequentially with 500ms delay to prevent 429 rate limiting.
- Auto-check now shows ❌ error message when processing fails (previously failed silently).
- `/list remove` now checks watchlist (previously only blacklist + whitelist).
- Auto-check spam protection: 10s per-user cooldown prevents overwhelming the bot.
- Search suggestions cached in `RosterCache` alongside roster data.
- Smart ScraperAPI fallback: caches Cloudflare block state for 5 minutes, skips wasted direct fetch.
- `RosterCache` model with 24h TTL — avoids repeated lostark.bible requests for same character.
- Broadcast notifications skip same-server (user already sees the reply).
- Improved display: sorted by priority (⛔→⚠️→✅→❓→⚪), summary header, title casing.
- Fixed lostark.bible search API payload format change.

### Changed

- Auto-check now resolves channels dynamically per message: checks DB `GuildConfig` first, falls back to `AUTO_CHECK_CHANNEL_IDS` env var. No bot restart needed after `/lasetup`.
- List broadcast (`broadcastListChange`) now merges channels from both DB `GuildConfig` and `LIST_NOTIFY_CHANNEL_IDS` env var, with automatic deduplication.
- Bot no longer skips auto-check setup when env vars are empty — guilds configured via `/lasetup` still work.

## [v0.3.0] - 2026-03-20

### Added

- Added `/search` command with filters: `min_ilvl` (default 1700), `max_ilvl`, `class` — find similar names on lostark.bible with cross-check against all lists.
- Added cross-server list notification — when entries are added/removed, bot broadcasts to all channels in `LIST_NOTIFY_CHANNEL_IDS`.
- Added ilvl >= 1700 validation on `/list add` — rejects characters below threshold.
- Added optional `logs` parameter to `/list add` for attaching lostark.bible logs URL as evidence.
- Added `/list view` with pagination (10/page, ◀ ▶ buttons) and 📎 Evidence button to show images. Supports `all` type to view all lists combined.
- Added `/lahelp` command showing all available commands (ephemeral).
- Added Roster and Logs links in list add success embed.
- Added similar name suggestions with list flags when OCR name has no roster (e.g. `⛔ Lùnaria, ❓ Lunaria`).
- Added server name filter to prevent OCR from extracting server names as player names (Vairgrys, Brelshaza, etc.).
- Added 🔍 reaction loading indicator for auto-check channel.
- Added user-friendly '429 Rate limited' message instead of raw HTTP status.
- Added roster match origin display — when flagged via `allCharacters`, shows "via MainChar — reason" across `/listcheck`, `/search`, auto-check.
- Added 📎 Evidence dropdown to `/search` for viewing flagged entries' images and details.
- Added ✅ reaction after successful auto-check completion.
- Added session timeout message ("Session expired") when `/list view` buttons expire.
- Added alt detection via Stronghold fingerprint when roster is hidden — matches Stronghold name + Roster Level across guild members to find same-account alts.
- Added guild member list check when roster is hidden — fast DB query for any flagged guild members.
- Added auto-enrich `allCharacters` in `/listcheck` — when a flagged character is found, background guild scan discovers and links alt characters automatically.
- Added auto-check channel feature — drop screenshots in configured channel(s), bot checks automatically without `/listcheck` command.
- Added `AUTO_CHECK_CHANNEL_IDS` env var (comma-separated) for multi-channel/multi-server auto-check support.
- Added multi-server monitoring — `TARGET_SERVERS` env var accepts comma-separated server names, single page fetch checks all servers.
- Added watchlist (`/list add type:watch`) for characters under investigation — shows ⚠️ icon in check results.
- Added roster progression tracking — `/roster` shows ilvl delta since last check (e.g. `1740 *(+10.00)*`).
- Added `RosterSnapshot` model for storing ilvl history per character.
- Added `PendingApproval` model with TTL index (24h auto-cleanup) to persist `/list add` approvals across bot restarts.
- Added MongoDB index on `allCharacters` field for fast `$in` lookups.
- Added OCR similar name suggestions in `/listcheck` and auto-check — when Gemini misreads diacritics, shows similar names with list flags instead of auto-replacing.
- Added fail reason display when roster lookup fails — shows cause (HTTP 403, timeout, etc.) to help diagnose issues.

### Changed

- Moved approver IDs from hardcoded to env vars: `OFFICER_APPROVER_IDS`, `SENIOR_APPROVER_IDS`, `MEMBER_APPROVER_IDS`. `SENIOR_APPROVER_ID` changed to array `SENIOR_APPROVER_IDS` for multiple seniors.
- Hidden "Added by" display from all outputs for privacy (data kept in DB).
- Merged `/check` into `/status` — `/status` now does live check instead of showing cached data. Removed `/check` command.
- Improved list add embed: shows character names instead of count.
- Renamed `/help` to `/lahelp` to avoid conflicts with other bots.
- `/list add` duplicate check now shows roster match origin: "roster match: MainChar is already in blacklist".
- Fixed ilvl check in `/list add` — now uses correct character ilvl from roster DOM instead of fragile regex.
- Refactored shared OCR + check logic into `listCheckService.js` — eliminates code duplication between `/listcheck` and auto-check.
- Replaced ScraperAPI with direct fetch for all lostark.bible requests — faster, no API key needed.
- Added automatic ScraperAPI fallback on 403/503 — direct fetch first, proxy retry if blocked by Cloudflare.
- `SCRAPERAPI_KEY` is now optional (no longer required at startup) but recommended as fallback.
- Improved Gemini OCR prompt with Lost Ark waiting room context for better name extraction accuracy.
- Gemini timeout/network errors now trigger model failover (previously only HTTP errors did).
- Added image upload size limit (20MB) to prevent memory issues.
- `/roster` blacklist/whitelist check now uses `allCharacters` field (previously only checked `name`).
- Replaced sequential `findOne` loops with batch `$in` queries for roster list checks.
- Replaced `Blacklist.find({}).lean()` with `countDocuments()` for debug logging.
- `/roster` name normalization now uses shared `normalizeCharacterName()` utility.
- Exported shared `FETCH_HEADERS` from rosterService for consistent User-Agent across all handlers.
- MongoDB connects once at startup (`bot.js`) instead of per-handler lazy connect.
- `/listcheck` alt enrichment runs in background after reply (user no longer waits for guild scan).
- `/status` now shows all monitored servers with individual status.
- Suppressed JSDOM CSS parse warnings with VirtualConsole.
- Standardized ilvl filter threshold from 1680 to 1700 across all features (roster suggestions, blacklist/whitelist checks, alt detection).

### Fixed

- Fixed `/roster` not detecting alt characters via `allCharacters` field (bug: only checked `name`).
- Fixed pending `/list add` approvals lost on bot restart (now persisted to MongoDB).

## [v0.2.0] - 2026-03-19

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

## [v0.1.0] - 2026-03-17

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