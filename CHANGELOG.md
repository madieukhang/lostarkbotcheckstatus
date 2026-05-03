# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates use the local calendar of each release.

This changelog focuses on user-visible changes, important backend fixes, and structural milestones. Deep implementation notes belong in commit messages or internal review docs.

## [v0.5.35] - 2026-05-03

### Changed
- Sweeping color-token migration: every embed-color call site that used a Discord-native palette hex (`0xed4245`, `0xfee75c`, `0x57f287`, `0x5865f2`, `0x99aab5`, `0x3b82f6`) or a known shade (`0x57d6a1` trustedSoft, `0xf1c40f` gold, `0x95a5a6` greyDark) now imports from `bot/utils/ui.js` `COLORS`. Touches 17 files across handlers/list/, handlers/setup/, and the top-level handlers (`rosterHandler`, `searchHandler`, `systemHandlers`, `statsHandler`, `helpHandler`, plus enrich/data and view/ui).
- `bot/handlers/list/helpers.js`: `buildListEditSuccessEmbed` and `buildListAddApprovalEmbed` migrated to `buildAlertEmbed` with `titleIcon`/`color` overrides so the edit success card and the approval-request DM card carry the same alert family layout (severity-driven timestamp + footer rendering) while keeping their list-type icon and color identity. `getListContext` now reads colors from `COLORS` instead of inlining hex.
- `bot/utils/ui.js` `COLORS` extended with `trustedSoft` (0x57d6a1, list-view trusted), `gold` (0xf1c40f, owner header in /la-remote), `greyDark` (0x95a5a6, inactive guild marker).

### Notes
- Admin-only divergent shades (0x2ecc71, 0xe74c3c, 0x9b59b6, 0x3498db) in `setup/remote.js` and `setup/syncImages.js` left inline. Intentional palette divergence for admin UX differentiation.
- Plain-text alert replies (~101 across 25 files) are the next wave - to be migrated to `buildAlertEmbed` in follow-up commits.
- 41/41 tests pass.

## [v0.5.34] - 2026-05-03

### Changed
- `bot/handlers/list/services/addExecutor.js` migrated to the new alert pattern. The success "Entry Added" card no longer builds a raw `EmbedBuilder`; it uses `buildAlertEmbed` with `titleIcon`/`color` overrides so it carries the list-type icon (⛔/✅/⚠️) and matches the rest of the alert family's layout. Six guard returns (trusted-exact, no-roster + suggestions, no-roster bare, ilvl-too-low, trusted-alt, duplicate) now drop their cosmetic icon prefix from `content` because user-facing render suppresses content when an embed is present (see `add/command.js#L110`); the remaining `content` strings are short summaries for log-style consumers (`approvalButton.js` error fallback, `bulk.js` result reporting).

### Notes
- This is the first migration after the `ui.js` foundation. Pattern locked in: alert-shaped → `buildAlertEmbed` with severity; list-typed → add `titleIcon`/`color` overrides; success card with structured fields → SUCCESS severity + list-type override.
- Commands and routes untouched; consumer contract preserved (`{ ok, content?, embeds, entry?, isDuplicate?, existingEntry? }`).

## [v0.5.33] - 2026-05-03

### Added
- `bot/utils/ui.js`: cross-handler UI tokens. Exports `COLORS` (Discord-native palette + trusted-blue), `ICONS` (severity / status / action / persona buckets), and helpers `relativeTime`, `absoluteTime`, `buildSessionFooter`, `buildCooldownLines`. Ported from RaidManage's `src/raid/shared.js` so both bots read consistently.
- `bot/utils/alertEmbed.js` now accepts `titleIcon` and `color` overrides so list-typed embeds (blacklist/whitelist/watchlist context) can carry their own icon and color while keeping the rest of the layout consistent.
- `test/ui-tokens.test.js`: 9 tests covering color hex codes, icon presence, native timestamp format, session-footer string, cooldown-line stacking.

### Changed
- `bot/handlers/list/enrich/ui.js` migrated to the new pattern as the exemplar for the broader rework: pulls icons + session-footer helper from `bot/utils/ui.js`, delegates layout to `buildAlertEmbed` with list-type icon + color overrides, voice unchanged (English-first Artist Kitsune; warm first-person, no em-dash, no stage directions).
- `alertEmbed.js` SEVERITY_CONFIG no longer inlines hex codes; it consumes `COLORS` and `ICONS` from `ui.js`. Behaviour identical for existing callers; severity icon prefix can now be suppressed by passing `titleIcon: ''` if a handler wants no icon at all.

### Notes
- Migration of remaining ~25 inline `new EmbedBuilder` callsites is staged for follow-up commits, one command at a time. Voice across LoaLogs stays English; sister bot RaidManage stays VN-first.
- 41/41 tests pass.

## [v0.5.32] - 2026-05-03

### Added
- `/la-list edit` gains an `additional_names` option: comma-separated alts to append to the entry's `allCharacters`. Officer/senior or entry owner only. Members with the option set get a clear reject (the approval flow does not carry `allCharacters` deltas through to the apply step, so silent dropping was the alternative). Designed to fill the gap where `/la-list enrich` cannot run, namely a target with hidden roster AND no guild (no candidate pool to walk).
- `bot/utils/names.js` exports a pure `parseAdditionalNames` helper (split, trim, title-case, dedupe within input + against existing roster + entry's primary name). Returns `{ added, duplicates }` so the success message can surface skipped duplicates without confusing the officer.
- `test/parse-additional-names.test.js`: 9 tests covering empty input, dedupe within input, dedupe against existing/primary, mixed partition, non-string input.

### Notes
- Persisted via `$addToSet` with `$each` for in-place edits; merged into the new `allCharacters` array for cross-list moves so `name` stays the primary identifier and the appended alts ride along.
- Help text in `/la-help` does not yet surface the new option (parallel work in progress on `bot/handlers/helpHandler.js`); the option still appears in Discord's slash-command UI auto-help.

## [v0.5.31] - 2026-05-03

### Removed
- Phase 4d cleanup: `bot/utils/deprecation.js` and `test/deprecation.test.js` deleted; the import + `usedLegacyName` finally block in `bot.js` are gone. The deprecation banner served its purpose during the (compressed) Phase 4b window; with the legacy aliases unregistered in Phase 4c, no slash invocation can reach a legacy name anymore so the helper has no callers.

### Notes
- Test count drops from 26 to 17 (9 deprecation tests removed alongside the helper).
- Phase 4 is now complete. Final command surface: 8 public + 2 owner commands, all `/la-` prefixed.

## [v0.5.30] - 2026-05-03

### Removed (BREAKING)
- Phase 4c hard cutover: legacy slash command names (`/status`, `/reset`, `/roster`, `/search`, `/list`, `/listcheck`, `/lahelp`, `/lasetup`, `/lastats`, `/laremote`) are no longer registered with Discord and no longer dispatch in `bot.js`. Every bot command now lives under the `/la-` prefix exclusively. Originally targeted 2026-05-17 (2-week soft-deprecation window); pulled forward to 2026-05-03 by Traine to wrap Phase 4 in a single sitting.
- `bot/commands.js` `PUBLIC_COMMAND_DEFS` and `OWNER_COMMAND_DEFS` are now single-name arrays; `buildCommands` and `buildOwnerCommands` register one command per entry (no more flatMap dual-registration).
- `/la-help` text drops the 2-week transition notice; line replaced with a one-liner explaining the `/la-` autocomplete grouping.
- `/la-setup defaultscope` description text updated from `/list add` to `/la-list add`.

### Notes
- Deprecation banner from Phase 4b (`bot/utils/deprecation.js` + `bot.js` finally block) intentionally kept this commit. It is now defensive only - covers the window where Discord may still cache a stale legacy registration after the deploy. Phase 4d will remove it next.

## [v0.5.29] - 2026-05-03

### Added
- `bot/utils/deprecation.js`: Phase 4b deprecation banner helper. Maps each legacy command name (`status`, `list`, `lahelp`, ...) to its modern `la-` twin and includes the hard cutover date (2026-05-17). For `/list ...` the banner appends the active subcommand so the note is directly actionable.
- `bot.js` dispatch wraps the legacy-name branch with a `finally` block that fires a single ephemeral `followUp` carrying the banner string. Banner is suppressed for modern names and skipped if the handler never replied or deferred.

### Notes
- Approach choice: followUp instead of prepending content. Decoupled from every handler's reply shape (content / embeds / files / mixed) so the banner appears uniformly without touching ~10 handler files.
- followUp is ephemeral and fires once per legacy invocation; modern `/la-*` invocations stay silent. Phase 4c (2026-05-17) removes both the legacy aliases and this banner code (Phase 4d).

## [v0.5.28] - 2026-05-03

### Changed
- Phase 4a (Direction D rollout): every slash command is now registered with both its legacy name and its `la-` prefixed twin. `/status` + `/la-status`, `/list` + `/la-list`, `/lahelp` + `/la-help`, etc. - both invocations route to the same handler in `bot.js`. Soft-deprecation window: 2 weeks before the legacy aliases come out (Phase 4c).
- `bot/commands.js` refactored: each command is now a builder function that takes a name; `PUBLIC_COMMAND_DEFS` and `OWNER_COMMAND_DEFS` arrays drive the dual-registration loop. No behavior change in the handlers themselves.
- `/lahelp` and `/la-help` text rewritten to surface the new names with a one-line transition notice. Legacy names still work; the help text shows the new names so users learn the new mental model first.
- `.gitignore` adds `docs/` per Traine - design docs stay outside the Railway deploy artifact. The existing `phase4-command-surface-refactor.md` is untracked but kept locally.

## [v0.5.27] - 2026-05-03

### Docs
- `docs/phase4-command-surface-refactor.md`: Phase 4 writing-plan covering the command surface audit and refactor directions. Direction B (entity-based split into `/la-blacklist` / `/la-whitelist` / `/la-watchlist`) was rejected by Traine because users are already used to the `/list ...` prefix. Direction D approved instead: keep the `/list` subcommand tree intact, rename top-level to `/la-list`, and add `la-` prefix to every other top-level command so Discord autocomplete groups all bot commands under `/la`. Five open questions remain (deprecation window length, multiadd-merge, /listcheck rename target, dashed-form for legacy `la*` commands, welcome embed flow). No code shipped here — design only.

## [v0.5.26] - 2026-05-03

### Added
- `/list enrich <name>` subcommand. Officer-only. Runs a stronghold deep scan against an existing list entry (blacklist / whitelist / watchlist), surfaces a confirm-dialog embed with discovered alts that are NOT yet in the entry's `allCharacters`, and on confirm appends them with `$addToSet`. Deep scan respects `STRONGHOLD_DEEP_CANDIDATE_LIMIT` (default 300, override via `deep_limit` option). Reuses the meta cache + adaptive backoff shipped in v0.5.25 so back-to-back `/list enrich` invocations on the same guild hit warm cache instead of refetching.
- 30-second per-entry cooldown to prevent accidental double-runs from doubling bible quota burn. 5-minute confirm session TTL.

### Notes
- Permission gate: officers/seniors only. The original entry already passed approval; enrichment only appends mechanically-matched alts (same stronghold name + roster level on bible), so no additional approval flow is needed.
- No cross-guild broadcast on enrich (Phase 3 MVP). The original `/list add` already broadcast the entry; enrichment is treated as an internal cleanup. Can be added later if audit trail is desired.

## [v0.5.25] - 2026-05-03

### Added
- `bot/utils/metaCache.js`: in-memory LRU+TTL cache for `fetchCharacterMeta` results. 30-min TTL, 5000-entry cap, LRU eviction on overflow. Successful meta is cached, transient failures (null) are not so a 429 outage cannot pin itself into the store. Tunable via `META_CACHE_TTL_MS` and `META_CACHE_MAX_SIZE`.
- Adaptive backoff inside the alt-detect `scanWorker`. Shared per-scan delay starts at 300ms, grows by 500ms on every transient failure up to 3000ms, shrinks by 100ms on every success back to the floor. All workers see the same delay so bible heat slows them down together. Tunable via `SCAN_BACKOFF_MIN_MS` and `SCAN_BACKOFF_MAX_MS`.

### Changed
- `fetchCharacterMeta` now consults the meta cache before fetching and stores successful results back. Callers can opt out with `useCache: false` (e.g. force-refresh paths). Back-to-back `/roster deep` and the upcoming `/list enrich` will hit warm cache instead of refetching the same 300 candidates.
- Deep-scan progress log now reports the current backoff value so operators can see bible heat in real time (`backoff 1800ms` next to the failed/alts counters).

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
