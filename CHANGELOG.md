# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates use the local calendar of each release.

This changelog focuses on user-visible changes, important backend fixes, and structural milestones. Deep implementation notes belong in commit messages or internal review docs.

## [v0.5.24] - 2026-05-03

### Changed
- `STRONGHOLD_DEEP_CANDIDATE_LIMIT` default raised 30 -> 300. A real-data scan against the Bullet Shell guild (820 members, 437 candidates at ilvl >= 1700) showed the target's five alts spread from candidate #70 down to #267 in the absolute ilvl-desc sort. The legacy cap of 30 missed every alt because the top of a large guild is dominated by other accounts' whale clusters - the target's own alts sit deeper in the sort. Smaller guilds simply finish early when candidates run out, so the cap costs nothing there.
- `STRONGHOLD_DEEP_CONCURRENCY` default lowered 6 -> 3. The scanWorker has no internal throttle and concurrency 6 triggered immediate 429 storms on bible (verified in smoke runs where 30/30 back-to-back candidates failed). Concurrency 3 halves the burst rate and lets bible's transparent rate limiter recover between fan-outs. Wall-clock impact at the new cap: ~5-7 min for a full 300-candidate scan in production, vs the legacy ~20 sec for a 30-candidate burst that returned no useful data.

## [v0.5.23] - 2026-05-03

### Changed
- `fetchCharacterMeta` and `fetchGuildMembers` (the alt-detect data path) now consume lostark.bible's SvelteKit `__data.json` endpoints instead of regex-scraping the page HTML. The structured payload removes the brittle `rosterLevel:(\d+)` / `stronghold:\{...\}` / `guild:\{...\}` matchers that were riding on bible's hydration script byte-stability. Network behavior is unchanged (same per-character GET, same ScraperAPI fallback, same 429 retry policy) - only the parse path is replaced.
- Guild member tuples now expose `combatPower: {id, score}` (or null) alongside the previous `{name, cls, ilvl, rank}`. The legacy regex captured only the first four positional fields and silently dropped combatPower; existing consumers that ignore the extra key continue to work.
- `bot/utils/bibleData.js` (new) provides `decodeBibleData` and `findBibleNode` helpers for the SvelteKit deduped data format. Pure functions, no I/O, reusable if other commands migrate later.
- HTML scrape paths kept as defensive fallbacks: the JSON endpoint is bible's internal hydration format and could shift on a deploy. Each consumer logs a warning and falls through to the legacy regex parser when the JSON layout misses the expected keys.
- `extractCharacterItemLevelFromHtml` is unchanged and still used by the HTML fallback; deliberately not migrated this round so we do not touch unrelated callers (`buildRosterCharacters`).

## [v0.5.22] - 2026-05-03

### Removed
- `/roster` no longer fetches up to 10 character pages just to surface the colored title decoration. The post-scrape `Promise.all` over `characters.slice(0, 10)` was a mandatory side request burst against `lostark.bible/character/NA/<name>` for every `/roster` invocation; the rendered output only used the title as italic suffix text. Cuts up to 10 bible round-trips per command and shrinks `/roster` time-to-first-render proportionally. Title field also removed from the rendered line so the dead conditional does not linger.

## [v0.5.21] - 2026-05-03

### Removed
- `/roster deep_scraperapi` slash option. Per team policy, ScraperAPI quota is never burned on the per-candidate fan-out scan because a single large guild (e.g. Bullet Shell) can drain the daily cap in one invocation. The `STRONGHOLD_DEEP_USE_SCRAPERAPI` env var stays in `config.js` as an emergency ops escape hatch and remains false by default.
- Dead `detectAltsViaStrongholdLegacy` (~100 lines in `bot/services/rosterService.js`). It was a remnant of the earlier refactor toward concurrent scanning, never exported, never referenced. Removed to keep the alt-detect surface single-source-of-truth.

## [v0.5.20] - 2026-04-25

### Changed
- Finished the `listHandlers.js` breakup. The old monolithic handler file is now a thin orchestrator that wires shared services into per-family factories under `bot/handlers/list/`.
- Command logic is now split by responsibility: `add`, `multiadd`, `edit`, `view`, `remove`, `quickadd`, `trust`, and `check`.
- This closes the 3-step refactor that moved pure helpers, shared closure services, and command-family handlers out of one giant file.

## [v0.5.19] - 2026-04-25

### Changed
- Step 2 of the `listHandlers.js` refactor: extracted shared closure-based services into `bot/handlers/list/services.js`.
- Broadcast, approval, DM sync, and bulk execution helpers now live in one shared service factory instead of being embedded in the main handler file.

## [v0.5.18] - 2026-04-25

### Changed
- Step 1 of the `listHandlers.js` refactor: extracted pure module-level helpers into `bot/handlers/list/helpers.js`.
- Behavior is unchanged; this release mainly set up cleaner boundaries for the later split.

## [v0.5.17] - 2026-04-25

### Fixed
- Migrated Discord client listeners to the `Events` enum, removing the `ready` deprecation warning on startup and aligning the bot with modern discord.js event naming.

## [v0.5.16] - 2026-04-25

### Changed
- Completed source-tree consolidation: `config.js` and `db.js` moved under `bot/`, leaving the repo root mostly for entrypoint and deployment metadata.
- Relative imports were rewritten so the codebase matches the new layout cleanly.

## [v0.5.15] - 2026-04-25

### Changed
- Reorganized file layout for clarity. Monitoring modules, models, and template services were moved into more appropriate `bot/` subfolders.
- No behavior change; this release was about project structure and maintainability.

## [v0.5.14] - 2026-04-12

### Added
- Added Secra raid variants (`Secra Nor`, `Secra Hard`, `Secra NM`) to `/list add`, `/list edit`, and `/list multiadd`.

## [v0.5.13] - 2026-04-12

### Fixed
- Broadcasts from the owner server now also reach the owner server's own notify channel, restoring the expected audit trail.

## [v0.5.12] - 2026-04-12

### Fixed
- `/list multiadd` now fails loudly on image rehost problems instead of silently storing a fragile legacy `imageUrl`.
- Bulk summary output now reports image-rehost failures explicitly.
- `/laremote action:syncimages` now attaches a full error file when the failure list is large.

## [v0.5.11] - 2026-04-11

### Fixed
- `rehostImage()` no longer double-wraps nested errors, making sync and evidence failures much easier to understand.
- `/laremote action:syncimages` now classifies dead legacy URLs as skipped instead of failed, reserving `Failed` for real infra issues.

## [v0.5.10] - 2026-04-11

### Fixed
- `/laremote action:syncimages` now surfaces the real per-entry error instead of a generic rehost failure.
- Added one retry per entry and increased throttling to reduce false failures from transient rate limits.

## [v0.5.9] - 2026-04-11

### Changed
- `/lahelp` gained a dedicated detailed help embed for `/laremote action:syncimages`.

## [v0.5.8] - 2026-04-11

### Fixed
- `/laremote action:syncimages` now uses compare-and-swap writes so concurrent edits cannot overwrite fresher evidence references.
- Legacy non-Discord image URLs now go through the correct rehost path instead of being misclassified as dead.
- Sync summary now breaks outcomes into `Synced`, `Skipped (dead)`, `Skipped (raced)`, and `Failed`.

## [v0.5.7] - 2026-04-11

### Added
- Added `/laremote action:syncimages`, a Senior-only one-shot migration for legacy evidence images.
- The migration is idempotent, throttled, and reports progress plus final errors.

## [v0.5.6] - 2026-04-11

### Changed
- `/list edit` success output now uses a richer embed that matches `/list add` style, including fresh evidence resolution and unified success rendering.

## [v0.5.5] - 2026-04-11

### Added
- `/list edit scope:` now supports promoting local blacklist entries to `global` and demoting global ones to server-only.
- Scope changes preserve audit metadata and existing evidence.

## [v0.5.4] - 2026-04-11

### Added
- Approval DMs for `/list add` and `/list edit` now include a `View Evidence (Fresh)` button for approvers.

### Fixed
- Approval-delayed `/list add` now resolves fresh evidence at execution time, preventing stale image URLs after long approval gaps.

## [v0.5.3] - 2026-04-11

### Fixed
- Approval records now keep rehost metadata all the way through the approval round-trip.
- `/list multiadd` rehosts member-submitted evidence at submit time instead of waiting for approval execution.
- `/search` and `/roster` now show rehosted evidence correctly for post-v0.5.2 entries.
- `/list edit` no longer drops image metadata during writes and now defers before slow rehost work to avoid Discord's 3-second timeout.

## [v0.5.2] - 2026-04-11

### Added
- Introduced evidence rehost storage: images are re-uploaded to a dedicated evidence channel and stored by message/channel reference instead of raw CDN URL.
- Added `/laremote action:evidencechannel` for setting the shared evidence channel.
- Added image rehost utilities and schema support for `imageMessageId` / `imageChannelId`.

### Fixed
- Evidence images no longer break after Discord CDN signed URLs expire.
- `/list view` no longer crashes on a missing `refreshImageUrl` import.

### Changed
- `/list view` now resolves fresh evidence URLs per page render and shows clearer fallback copy when refresh fails for legacy entries.

## [v0.5.1] - 2026-04-11

### Added
- Added `/list multiadd`, supporting bulk add of up to 30 entries from a styled Excel template.
- Member flow submits one batch approval instead of spamming approvers row by row.
- Officers and Seniors can bypass approval and execute directly with progress updates.

### Fixed
- Bulk approval now uses atomic delete-on-approve to prevent double execution.
- Members can no longer bypass Senior-only approval through mis-scoped approver IDs.
- Approver DMs now sync after a decision so stale buttons disappear.
- Failure cleanup is stricter when approval delivery or execution breaks.

## [v0.5.0] - 2026-04-08

### Added
- Introduced server-vs-global blacklist scope with guild-aware uniqueness and owner-guild visibility for local entries.
- Added `/lasetup off` and `/lasetup defaultscope`.
- Added `TrustedUser` plus `/list trust action` to protect trusted characters and their alts from being added to any list.
- Trusted indicators now appear in auto-check, `/listcheck`, `/search`, and `/roster`.
- Evidence links became clickable in `/list view`.

### Changed
- All slash commands now disable DM permission by default.
- Scope precedence (`server > global`) is now applied consistently.
- `/search` moved to batched queries for much lower DB round-trip count.
- Approval and edit flows now carry richer context through the full round-trip.
- Default blacklist scope changed from `server` to `global`.

## [v0.4.0] - 2026-03-28

### Added
- Added `/list edit` for existing entries, including move-across-list support.
- Added Quick Add from auto-check results.
- Added deeper roster / alt-detection support, guild config commands, roster cache, and smarter scraper fallback cache.
- Added progress messaging for auto-check and stronger Gemini failover handling.
- Added per-user auto-check spam cooldown.

### Changed
- Auto-check now resolves channels dynamically per message.
- Broadcasts skip the origin server.
- Duplicate handling became more interactive with side-by-side compare and overwrite controls.
- Display sorting was adjusted for clearer priority.

### Fixed
- `/roster` alt detection now checks `allCharacters`, not just the main name.
- Pending approvals now survive bot restart.
- Updated compatibility for the `lostark.bible` search API payload shape.

## [v0.3.0] - 2026-03-20

### Added
- Added `/search` with optional filters and cross-check support.
- Added cross-server broadcast notifications on add/remove.
- Added `/list view` pagination and evidence dropdown.
- Added `/lahelp`.
- Added watchlist support, `ilvl >= 1700` validation, multi-server monitoring, stronger hidden-roster fallback checks, roster snapshots, and OCR name-suggestion help.

### Changed
- Approver IDs moved to environment configuration.
- `/check` was merged into `/status`.
- `/help` was renamed to `/lahelp` to avoid conflicts.
- Fetch flow switched to direct requests first, with ScraperAPI as fallback.
- Replaced sequential DB lookups with batched `$in` queries where possible.

## [v0.2.0] - 2026-03-19

### Added
- Added image-driven `/listcheck` via Gemini OCR.
- Added Gemini model failover support.
- Added approver-ID workflow for `/list add`, including DM approve/reject buttons and auto-approve for officer/senior roles.
- Added requester preview embeds and synchronized approver-DM state.
- Added `addedByDisplayName` audit field.

### Changed
- Refactored from a monolithic `bot.js` into `bot/handlers/*`, `bot/services/*`, and `bot/utils/*`.
- Roster output now includes class info.
- Corrected the weekly maintenance window.

## [v0.1.0] - 2026-03-17

### Added
- First tagged release with `/list add`, `/list remove`, and `/listcheck`.
- Added the `raid` option on `/list add`.
- Added `addedByUserId`, `addedByTag`, and `allCharacters` audit / roster snapshot fields.
