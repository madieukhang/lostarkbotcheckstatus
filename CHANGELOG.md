# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates use the local calendar of each release.

This changelog focuses on user-visible changes, important backend fixes, and structural milestones. Deep implementation notes belong in commit messages or internal review docs.

## [v0.5.50] - 2026-05-03

### Fixed
- Scan progress embed (`/la-list enrich` + `/la-roster deep:true`) now renders the elapsed-time line as a live Discord-native relative timestamp instead of leaking the raw `<t:UNIX:R>` token. Discord parses timestamp tokens only inside message content + embed description, NOT inside footers / titles, so the "started X ago" line moved from footer to description. Footer now carries the static `Backoff Xms · 30s update interval` info instead.

### Notes
- Visual: officers watching a long scan now see an elapsed-time ticker that updates every minute as Discord re-renders the embed client-side, without needing the bot to push edits for each tick.
- 42/42 tests pass.

## [v0.5.49] - 2026-05-03

### Changed
- `/la-roster` visible-roster card polish:
  - Title now reads `🛡️ <Name>'s Roster · N characters` instead of `Roster - <Name>`. Character count up front gives an at-a-glance read.
  - Description gets a top-line summary `Top character: <Name> · <Class> · <ilvl>` so the highest-geared char is visible without scanning the full list.
  - Footer changes from `N character(s) · lostark.bible` to `Source: lostark.bible · re-run /la-roster to refresh` (count moved to title, replaced with a refresh hint).

### Notes
- 42/42 tests pass.

## [v0.5.48] - 2026-05-03

### Changed
- `/la-status` server status card polished. Author header replaces bare title; new headline at the top of the description summarises overall health (`All monitored servers online` / `Some servers are offline` / `Maintenance window in progress`) so the embed reads at a glance without parsing per-server fields. Per-server status entries stay as inline fields with the same status glyphs (🟢/🔴/🟡). Footer cites the source page (`playlostark.com`) and tells the user how to refresh.
- `STATUS_GLYPH` lookup table replaces the inline glyph switch so the same icons are reused in the description headline and the field values.

### Notes
- 42/42 tests pass.

## [v0.5.47] - 2026-05-03

### Changed
- `/la-stats` dashboard polished. Author line + descriptive intro replace the bare title; uptime now formatted as `2d 4h 13m` instead of bare hours/minutes; new "Started <relative>" line under the bot stats; new "Activity (last 7 days)" field showing recent blacklist additions as a growth pulse.
- Field icons pulled from `ICONS` token instead of inline glyphs. Empty separator field (`​`) inserted between the top stat row and the activity field for visual grouping.
- Footer adds "Officer-only command · ephemeral reply" so observers know the embed is invisible to non-callers.

### Notes
- 42/42 tests pass.

## [v0.5.46] - 2026-05-03

### Fixed
- `fetchCharacterMeta` now builds fresh fetch options for each JSON retry and HTML fallback instead of reusing the same `AbortSignal.timeout(...)`. This removes a hidden failure mode where the 5s retry wait left the second request with a nearly-expired timeout, causing recoverable candidate probes to count as failed.
- Candidate meta retry now treats transient bible `502/503/504` responses like `429`: in gentle scans it waits and retries once before falling back or counting the candidate as failed. This applies to both `/la-list enrich` and `/la-roster deep:true` because both use the same stronghold detector.
- Guild member JSON -> HTML fallback now also gets a fresh timeout signal.

### Changed
- Help/runtime comments now describe the gentle scan as ~10-15 minutes instead of the old fast-scan ~5-7 minute estimate.

### Notes
- Added a regression test proving transient profile failures retry against a fresh timeout signal.

## [v0.5.45] - 2026-05-03

### Changed
- `/la-list view` paginated browse and `/la-list view type:trusted` redesigned for breathing room and visual hierarchy. Replaced the cramped one-line-per-entry description with a two-line layout:
  - **Line 1**: position number, list-type icon, name (linked to lostark.bible roster), scope tag in code-style brackets.
  - **Line 2** (`└ ` tree-prefixed): reason (truncated to 80 chars), raid in code-style backticks, relative-time, evidence link (when present).
  - Empty line between entries so the page reads more like a card stack than a wall of text.
  - Header line at top of description shows `Showing N of M entries · page X / Y` so users get context without hunting in the footer.
- Pagination row now adds a non-clickable middle button showing the page indicator (`X / Y`) so it reads at a glance even when the embed has scrolled. Previous + Next buttons gain icon glyphs from `ICONS` instead of inline arrow chars.
- Expired-session row reads `Session expired · re-run /la-list view` on the disabled middle button so the user knows what to do, instead of just two greyed-out arrows.
- `buildEvidenceEmbed` adds the entry's roster URL as the embed URL (clickable title) and uses inline `Raid · List · Added` fields for a cleaner card.
- All inline hex colors removed; uses `COLORS.trustedSoft` for the trusted list embed and `COLORS.info` for the all-lists view.

### Notes
- Description hard-cap at 4096 chars enforced via `.slice(0, 4096)`. With 10 entries × ~200 chars/entry the typical page is ~2000 chars, well clear.
- 42/42 tests pass.

## [v0.5.44] - 2026-05-03

### Changed
- Bot-wide em-dash purge per the no-em-dash project rule. ~220 occurrences swept across 36 files (handlers, services, models, utils, config). Spaced em-dashes (` — `) collapsed to middot (` · `) so user-facing copy and bullet-list separators read consistently with the existing list-view / progress-embed style. Bare em-dashes inside identifiers and ranges fell back to regular hyphen (`-`).
- Files touched: `bot/handlers/helpHandler.js` (the heaviest, 61 occurrences in the help text), all `bot/handlers/list/**` files, top-level handlers, `bot/handlers/setup/**`, `bot/services/**`, `bot/models/**`, `bot/utils/**`. Comments + docstrings included since the project rule applies bot-wide.

### Notes
- 41/41 tests pass.
- This is the cleanup pass before the broader "prettier embed" rework Traine asked for; consistent typography is foundation for the visual polish that follows.

## [v0.5.43] - 2026-05-03

### Changed
- `detectAltsViaStronghold` (powering `/la-list enrich` + `/la-roster deep:true`) defaults the per-candidate scan to **gentle** mode now, matching the Phase 1 verification scan parameters that successfully found Ainslinn's 5 alts. Concrete defaults:
  - **concurrency = 1** (sequential, was 3)
  - **backoff floor = 1500ms** (was `config.scanBackoffMinMs` = 300ms)
  - **retryOnRateLimit = true** (was false). 429s now wait 5s and retry once at the `fetchCharacterMeta` layer instead of immediately counting as failed.
- The original "fast" preset (concurrency 3, no retry, 300ms floor) is preserved as opt-in via `mode: 'fast'`. Fast is appreciably faster when bible is cool but had a 100% failure rate during peak hours on Bao's 2026-05-03 4:30 PM scan, which is what motivated this default flip.
- The detector's return now exposes `mode` and `retryOnRateLimit` so progress / preview embeds can render the actual run config, not just the request.

### Why
- The Phase 1 verification POC that found Ainslinn's 5 alts at #70/#109/#154/#188/#267 ran sequentially with a 1.5s throttle and observed a 25.8% failure rate — high but workable. The current production fast preset hit 100% failure at peak hours because bible blanket-rejects bursty traffic and there is no retry to give a second chance. Making gentle the default brings production parity with the POC that the memory anchor data was collected from.

### Notes
- Wall-clock estimate for `/la-list enrich` shifts from "~5-7 min" to **"~10-15 min"** in the embed copy. The Discord webhook reply ceiling is 15 min so cap 300 + gentle pace fits with a slim margin; cap 250 is a safer bet on hot bible days. Officers can override per invocation via `deep_limit`.
- `bot/handlers/list/enrich/index.js` and `bot/handlers/rosterHandler.js` initial progress embeds now seed `currentBackoffMs: 1500` so the very first paint shows the gentle pace correctly before the scan has emitted its first onProgress tick.
- 41/41 tests pass.

## [v0.5.42] - 2026-05-03

### Added
- `/la-list add` success card now ships with an **Enrich now** button when the entry was created against a hidden roster. Officers / entry owners can hit the button to kick off the same stronghold scan as `/la-list enrich` without re-typing the name. Members landing on the card cannot bypass the gate; the button click re-validates officer permission + the 30s per-entry cooldown server-side.
- New embed field "Hidden roster detected" added to the success card explaining what the button does and the expected wall-clock (5-7 min). Field is only attached when `rosterVisibility === 'hidden'`.
- `bot/handlers/list/enrich/index.js` `handleListAddEnrichHiddenButton` extracted as the button handler. Shares the post-validation pipeline with `handleListEnrichCommand` via a new private `runEnrichFlow(interaction, { name, cap })` helper, so slash + button paths emit identical progress + preview embeds.

### Changed
- `bot/handlers/list/services/addExecutor.js` `executeListAddToDatabase` return now includes a `components` array (empty when roster is visible). Three consumers updated to relay `result.components ?? []` to Discord:
  - `list/add/command.js` (auto-approve path)
  - `list/quickadd/index.js` (modal-driven add)
  - `list/services/approvals.js#notifyRequesterAboutDecision` (approval-flow requester ping)
- `bot.js` dispatch grows a new branch for the `list-add:enrich-hidden:<encodedName>` button customId family.

### Notes
- 41/41 tests pass. No DB schema change; the button is computed from the existing `rosterVisibility` field returned by `buildRosterCharacters`.
- Bulk add (`/la-list multiadd`) intentionally does NOT attach the button per-row; it ships a single aggregate summary embed where per-entry buttons would clutter.

## [v0.5.41] - 2026-05-03

### Added
- `/la-roster deep:true` now shows the same live progress embed as `/la-list enrich`. Both deep-scan paths (visible-roster fallback + hidden-roster fallback) emit a 0% progress embed when the candidate fan-out begins, then update via the shared 30s-throttled `onProgress` callback. Progress bar, scanned/total count, alts found, failed count, current backoff, relative timestamp, all consistent across the two commands.
- `bot/utils/scanProgressEmbed.js` (new): generic `buildScanProgressEmbed({ title, subtitle, color, titleIcon, progress })` shared by enrich + roster. Wraps `buildAlertEmbed` with a 20-character progress bar plus the standard "Backoff Xms · started <relative>" footer.
- `bot/utils/ui.js` exports `buildProgressBar(percent, width)` so any future scan-style UI can reuse the same glyph treatment.

### Changed
- `bot/handlers/list/enrich/ui.js` `buildEnrichProgressEmbed` is now a thin wrapper that adds the list-type icon + color (blacklist/whitelist/watchlist context) on top of the shared embed builder.
- `bot/handlers/rosterHandler.js`:
  - Hidden-roster path: replaces the previously-static intermediate state with the progress embed; onProgress wires through `makeRosterScanProgressCallback`.
  - Visible-roster path: pre-fetches `meta` + `guildMembers` so the initial 0% embed has guild context, then passes them to `detectAltsViaStronghold` (the detector skips its own internal target/guild fetches when both are pre-supplied). The final editReply at the bottom of the branch overwrites the progress embed with the full roster card + evidence + deep-scan addFields.
- The visible-roster trade-off: during the 5-7 minute scan the user sees only the progress embed (not the partial roster card with progression / char list). The roster card was being built in memory but never rendered before the scan anyway, so nothing is actually lost; the final reply renders the complete card.

### Notes
- 41/41 tests pass. No handler signatures changed; both deep-scan call sites still accept all the same options.
- Discord webhook 5-edits-per-5s ceiling: 30s throttle = ~10-14 edits over a typical scan, well clear.

## [v0.5.40] - 2026-05-03

### Added
- `/la-list enrich` now surfaces **live progress** during the 5-7 minute stronghold scan instead of leaving the officer staring at a static "Running stronghold deep scan..." line. The embed updates every ~30s with a 20-character text progress bar, scanned/total candidate count, alts-found count, failed count, current adaptive backoff value, and a Discord-native relative timestamp showing when the scan started.
- `bot/handlers/list/enrich/ui.js` exports `buildEnrichProgressEmbed` and a small `buildProgressBar` helper.
- `bot/services/roster/altDetection.js` `detectAltsViaStronghold` accepts an `onProgress` callback. The hook fires at the same per-25 cadence as the existing console log, with a fire-and-forget call so a slow / rate-limited UI edit cannot bottleneck the scan worker.

### Changed
- `enrich/index.js` initial reply switches from a one-liner to the structured progress embed (0% bar, ready to update). Throttled to one Discord edit every 30s (10-14 updates over a typical 5-7 min scan; well under Discord's 5-edits-per-5s webhook ceiling).
- The "no alts matched" post-scan reply migrated from plain content to an INFO embed with scanned / failed counts as fields and a contextual footer ("rate-limit retry hint" if failures > 0, "below 1700 ilvl or no alts in guild" otherwise).

### Notes
- The final 100% progress tick is intentionally suppressed because the post-scan branch (preview-with-alts or no-alts-matched) overwrites the embed immediately afterwards; emitting "100%" would flicker for milliseconds before being replaced.
- 41/41 tests pass.

## [v0.5.39] - 2026-05-03

### Fixed
- `/la-list enrich` and `/la-roster deep:true` regressed after the v0.5.x ScraperAPI hardening: the gate was too coarse and disabled ScraperAPI fallback even on the **single-request** meta + guild member probes, not just the high-fanout candidate scan. When bible was rate-limiting (very common during peak hours), the single fetch returned empty and there was no fallback, so officers saw `Guild Member List Unavailable` immediately, never reaching the actual scan. Reproduced by Bao on Ainslinn (which previously found 5 alts cleanly).
- Both call sites (`bot/handlers/list/enrich/index.js`, `bot/handlers/rosterHandler.js`) now omit `allowScraperApi: false` on the pre-flight `fetchCharacterMeta` + `fetchGuildMembers` calls. ScraperAPI is still hard-locked OFF for the per-candidate scan (`useScraperApiForCandidates: false`); that is the actual high-fanout path the .env warning is about.

### Notes
- Updated the in-progress message text on `/la-list enrich` from "ScraperAPI off" to "candidate ScraperAPI off" to reflect the more precise gate.
- Dead `allowScraperApiForTarget` / `allowScraperApiForGuild` options dropped from both call sites since `targetMeta` and `guildMembers` are pre-supplied (the detector's own internal fetches never run when callers pass these in).
- 41/41 tests pass.

## [v0.5.38] - 2026-05-03

### Changed
- Wave 1 alert sweep finishing pass on the `/la-list add` approval flow files. Failure / guard alerts that are NOT pure state-change audit lines were converted to `buildAlertEmbed`:
  - `list/add/approvalButton.js`: approval-execution-failed (also threaded through syncApproverDmMessages + notifyRequesterAboutDecision so requester sees the same structured failure card the seniors do).
  - `list/add/overwriteButton.js`: request-expired, original-entry-missing, overwrite-failed.
  - `list/add/editApproval.js`: original-entry-missing, move-blocked, scope-change-raced. Trusted-block branch dropped its redundant content prefix in favour of the existing trusted block embed.
  - `list/add/evidenceButton.js`: not-authorised, request-expired, no-evidence-available.
  - `list/enrich/index.js`: officer-only-command guard.

### Notes
- Pure status-change messages paired with `buildApprovalResultRow(...)` button rows stay as plain `content` strings (e.g. "Approved by X" / "Rejected by X" / "Kept existing entry" / "Overwritten by X" / "Edit approved by X"). These are audit-trail metadata lines, one short sentence each, and the button row carries the visual semantic. Mixing embeds for status + buttons would add ceremony without info gain.
- The "Bot connected" channel test message in `setup/guildSetup.js` (auto-deletes after 30s) likewise stays as plain content; it's an inline channel confirmation, not a reply.
- 41/41 tests pass.

## [v0.5.37] - 2026-05-03

### Changed
- Wave 1 alert sweep extended to top-level handlers + setup. Plain-text replies migrated to `buildAlertEmbed`:
  - `autoCheckHandler.js`: auto-check-failed.
  - `rosterHandler.js`: no-roster-with-suggestions, no-roster-bare, roster-fetch-failed.
  - `searchHandler.js`: bible-unavailable, no-results, no-results-with-filters, not-your-session, evidence-unavailable, search-failed.
  - `systemHandlers.js`: status-fetch-failed, state-reset (success card).
  - `setup/guildSetup.js`: wrong-channel-type, missing-permissions (used by both autochannel + notifychannel via replace_all), server-only, manage-server-required.
  - `setup/syncImages.js`: evidence-channel-missing.
  - `setup/remote.js`: senior-only, not-your-session, owner-guild-id-missing, channel-option-required, wrong-channel-type, missing-permissions, scope-required.

### Notes
- The "✅ Bot connected!" test message in `setup/guildSetup.js` (sent into the configured channel itself, then auto-deleted after 30s) intentionally stays as plain content - it's a brief one-liner meant to be visible inline in the channel as a connection confirmation, not a structured alert.
- 41/41 tests pass.

## [v0.5.36] - 2026-05-03

### Changed
- Wave 1 alert-to-embed sweep across the `/la-list *` command surface. Plain-text replies that carried severity icons (❌/⚠️/✅/🛡️) are migrated to `buildAlertEmbed` calls so the alert family reads consistently: severity-coded color, icon prefix, structured fields, optional footer hints. Files touched in this commit:
  - `list/add/command.js`: 5 guard alerts (server-only, reason-required, invalid-attachment, approval-delivery-failed, proposal-failed).
  - `list/edit/command.js`: 6 guards (server-only, entry-not-found, officer-only-option, no-changes, scope-not-applicable, scope-change-blocked, no-effective-changes, trusted-block).
  - `list/edit/applyNow.js`: move-blocked + scope-change-raced + edit-failed.
  - `list/edit/approvalRequest.js`: approval-delivery-failed + edit-request-sent (info-styled).
  - `list/enrich/index.js`: 7 guards (no-list-entry, profile-not-found, no-guild, guild-list-unavailable, session-expired, not-your-session × 2, internal-error).
  - `list/multiadd/index.js`: 4 guards (server-only, template-failed, invalid-attachment, parse-failed, unknown-action).
  - `list/multiadd/attachment.js`: returns clean reason strings (icon prefix moved to caller's embed).
  - `list/multiadd/confirmButton.js`: 5 alerts (request-expired, not-your-request, bulk-cancelled, approval-routing, delivery-failed, request-failed).
  - `list/multiadd/approvalButton.js`: 2 guards (not-authorised, request-expired).
  - `list/quickadd/index.js`: 3 alerts (reason-required, approval-delivery, quick-add-failed).
  - `list/trust/index.js`: 5 alerts (officer-only, not-trusted, blacklisted, already-trusted, success cards via buildAlertEmbed with titleIcon/color overrides).
  - `list/remove/index.js`: not-found + remove-failed.
  - `list/view/index.js`: 5 alerts (server-only, trusted-empty, all-empty / list-empty, not-your-session, view-failed).
  - `list/check/index.js`: ocr-failed, no-names-detected, check-failed.

### Notes
- Approval-flow status messages ("Approved by X" / "Rejected by X") in `add/approvalButton.js` and `add/editApproval.js` are intentionally kept as plain `content` strings because they pair with `buildApprovalResultRow(...)` button rows; the status header + button row pattern is the approval audit trail and each status line is one short metadata sentence, not a multi-field alert.
- 41/41 tests pass. No handler signatures changed.

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
