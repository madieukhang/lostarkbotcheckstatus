# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates in the local calendar of the release.

## [v0.5.16] - 2026-04-25

### Changed

- Final pass on source-tree consolidation: `config.js` and `db.js` moved from root into `bot/`. Root now holds only the entry point (`bot.js`), meta files (package.json, Dockerfile, railway.toml, etc.), and gitignored runtime dirs. All source code lives under `bot/`.
- All relative imports rewritten; resolver script confirms every import target exists.

## [v0.5.15] - 2026-04-25

### Changed

- File layout reorganized for clarity. No behavior change. Entry point (`bot.js`) stays at root for Dockerfile / Railway compatibility; everything else moved under `bot/`:
  - `monitor.js` + `serverStatus.js` -> `bot/monitor/` (paired status-polling module)
  - `models/` -> `bot/models/` (consistency with the rest of the bot tree)
  - `bot/utils/multiaddTemplate.js` -> `bot/services/multiaddTemplateService.js` (it was a feature module misfiled under utils)
- All relative imports rewritten to match. Architecture diagram in README refreshed.

## [v0.5.14] - 2026-04-12

### Added

- Secra raid entries (`Secra Nor`, `Secra Hard`, `Secra NM`) in the `/list add` / `/list edit` / `/list multiadd` raid dropdown, picked up automatically by the Excel template + parser via `RAIDS` in `models/Raid.js`.

## [v0.5.13] - 2026-04-12

### Fixed

- Broadcasts from the owner server now hit the owner's own notify channel. `resolveBroadcastChannels` previously excluded the origin guild for all broadcasts; exempting the owner guild from that exclusion restores the audit trail.

## [v0.5.12] - 2026-04-12

### Fixed

- `/list multiadd` no longer silently stores a legacy `imageUrl` when `rehostImage()` fails. Bulk flow now uses `throwOnError: true` and surfaces per-row rehost errors in the summary embed (`🖼️ Image rehost failed (N)`) with a footer warning about 24h CDN expiry.
- Removed the redundant `By <user>` footer from `/list multiadd` bulk broadcasts (matches `/list add` style).
- `/laremote action:syncimages` attaches a full `syncimages_errors_<date>.txt` file whenever the error count exceeds 10 instead of truncating to "and 39 more".

## [v0.5.11] - 2026-04-11

### Fixed

- `rehostImage()` no longer double-wraps error messages (e.g. `download fetch threw: download HTTP 404`). Download step split into three separate try blocks so a thrown error doesn't get re-caught by a sibling catch.
- `/laremote action:syncimages` reclassifies HTTP 4xx/5xx download failures as `Skipped (dead URLs)`. Discord permanently removes some attachment files ~30-90 days after message post; those are unrecoverable. `Failed` is now reserved for genuine infra errors.

## [v0.5.10] - 2026-04-11

### Fixed

- `/laremote action:syncimages` now surfaces the real error per entry instead of a generic "rehost failed after successful URL refresh". `rehostImage()` gained an opt-in `meta.throwOnError` parameter; legacy callers are unaffected.
- Added a per-entry retry (first attempt → 2s wait → second attempt) so transient rate-limit blips don't mark an entry permanently failed.
- Throttle bumped 200ms → 500ms between entries; stays comfortably below Discord's 5-msg/5-sec channel limit at the cost of a longer one-shot migration runtime.

## [v0.5.9] - 2026-04-11

### Changed

- `/lahelp` now includes a dedicated detailed embed for `/laremote action:syncimages` (owner guild only), mirroring the `multiaddEmbed` pattern: prerequisites, per-entry flow, result counters, troubleshooting.

## [v0.5.8] - 2026-04-11

### Fixed

- `/laremote action:syncimages` now uses a compare-and-swap write so a concurrent `/list edit` or `/list multiadd` can't overwrite newer evidence refs with the migration loop's stale snapshot. Races count as a new `Skipped (raced)` bucket.
- Legacy external (non-Discord) URLs now go straight through `rehostImage()` instead of `attachments/refresh-urls`, fixing the false-positive "dead URL" classification for alive Imgur/Postimages links.
- Summary embed gained a four-counter layout (`Synced`, `Skipped (dead)`, `Skipped (raced)`, `Failed`).

## [v0.5.7] - 2026-04-11

### Added

- `/laremote action:syncimages` — Senior-only one-shot migration that walks every pre-v0.5.2 entry (legacy `imageUrl` only, no rehost refs) and migrates them into the rehost storage path via Discord's `POST /attachments/refresh-urls` + reupload.
- Idempotent (query filter requires `imageMessageId === ''`), 200ms throttle, progress embed every 10 entries, final summary with up to 10 errors inline.
- Aborts with a clear error if the evidence channel isn't configured yet.

## [v0.5.6] - 2026-04-11

### Changed

- `/list edit` success response is now a rich embed matching `/list add` style (color, title, fields, editor footer, fresh evidence image resolution). Both auto-approve and approval-execution paths render identically via a new shared `buildListEditSuccessEmbed` helper.

## [v0.5.5] - 2026-04-11

### Added

- `/list edit scope:` option promotes a local blacklist entry to `global` or demotes a global one to server-only, preserving `addedAt` / `addedBy` / `allCharacters` / evidence.
- Auto-approve uses target state (demote = auto, promote = Senior approval); conflict detection catches collisions before writing; broadcast routing follows the final scope; no-effective-changes guard rejects scope-only noise.

## [v0.5.4] - 2026-04-11

### Fixed

- Approval-delayed `/list add` now resolves a fresh evidence URL after `Model.create()` instead of reusing the snapshot from submit time; prevents broken images in the success + broadcast embeds when approval gaps stretch past 24h.

### Added

- `📎 View Evidence (Fresh)` button on `/list add` and `/list edit` approval DMs. Re-resolves a freshly-signed URL on click (rehost message for v0.5.2+ entries, legacy URL with "may have expired" footer otherwise). Assigned approvers only.

## [v0.5.3] - 2026-04-11

### Fixed

- `PendingApproval` now carries `imageMessageId` + `imageChannelId` through the approval round-trip. The schema previously only had `imageUrl`, so approved adds/edits silently lost rehost permanence and fell back to the expiring URL path.
- `/list multiadd` member approval rehosts rows **at submit time** (Confirm click) instead of at execution; prevents bulk imports from dying if approval sits for a day.
- `/search` and `/roster` now display rehosted evidence via `entryHasImage` + `resolveDisplayImageUrl` — post-v0.5.2 entries previously showed no image in these commands.
- `/list edit` write paths (cross-list move, in-place, duplicate overwrite) persist all three image fields atomically instead of dropping rehost refs.
- `/list edit` now `deferReply()` before calling `rehostImage()` so slow uploads don't trip Discord's 3s interaction timeout.

## [v0.5.2] - 2026-04-11

### Added

- Evidence rehost feature: bot re-uploads every `/list add` / `/list edit` / `/list multiadd` image to a dedicated evidence channel and stores `imageMessageId` + `imageChannelId` instead of the original CDN URL. Fresh signed URLs resolved on display.
- `/laremote action:evidencechannel` — Senior-only command to set the evidence channel (persists to owner `GuildConfig.evidenceChannelId`, bot-wide).
- New `bot/utils/imageRehost.js` with `rehostImage` / `refreshImageUrl` / `resolveDisplayImageUrl`.
- Schema fields `imageMessageId` / `imageChannelId` on Blacklist / Whitelist / Watchlist. Legacy `imageUrl` kept as fallback.

### Fixed

- Discord CDN evidence images no longer expire silently after ~24h. Root cause: signed expiry tokens on CDN URLs introduced in 2024. Legacy entries (pre-rehost) stay broken — use `/laremote action:syncimages` to migrate them.
- `/list view` ReferenceError from a missing `refreshImageUrl` import — ESM only validates identifiers at execution time so the bug surfaced only when a user invoked the command.

### Changed

- `/list view` paginated 📎 links resolve a fresh CDN URL per page render (parallel `Promise.all`, ~10 fetches/page, < 1s typical). Pagination handlers `deferUpdate()` before rebuilding.
- `/list view` evidence dropdown preview shows "Image link expired" when refresh fails (legacy entries only).

## [v0.5.1] - 2026-04-11

### Added

- `/list multiadd` — bulk add up to 30 entries via a styled Excel template with dropdown validation, example row, frozen header, and an Instructions sheet.
- `action:template` downloads the template; `action:file` uploads a filled sheet, shows preview embed with ≤20 valid rows + first 10 errors + Confirm/Cancel buttons (5-min expiry).
- Validation: required fields, type/scope enum, URL format, intra-file dedup (case-insensitive), ilvl ≥ 1700, reuses `/list add` rules.
- Member flow: single `PendingApproval` batch with one aggregated DM to Senior (no per-row spam); single aggregated broadcast on approval.
- Officer/Senior bypass approval; progress updates every 5 rows during direct execution.
- `exceljs@^4.4.0` dependency; new `bot/utils/multiaddTemplate.js` (zero Discord/DB coupling, independently testable).

### Fixed

- P1 race: atomic `findOneAndDelete` in the multiadd approval handler prevents double execution when two approvers click simultaneously.
- P2 auto-approve scope: members can no longer bypass bulk approval via `MEMBER_APPROVER_IDS` (bulk is Senior-only now).
- P3 stale approver DMs: `syncApproverDmMessages` edits the other approvers' DMs after one approver clicks, so buttons disappear instead of lingering.
- Orphan DMs on DB failure: approval record cleaned up if zero deliveries or any step fails.
- Command description fixed to match handler behavior.

## [v0.5.0] - 2026-04-08

### Added

- **Server vs Global blacklist**: `scope` field (`global` / `server`) with compound unique index `{name, scope, guildId}`. Server-scoped entries stay local to their guild; owner guild sees all server-scoped entries with `(Local: GuildName)` labels.
- `/lasetup off` toggles global-list notifications on/off per server.
- `/lasetup defaultscope` sets the default blacklist scope per guild.
- `TrustedUser` model + `/list trust action` (add/remove) — trusted characters and their alts cannot be added to any list (officer/senior only).
- 🛡️ trusted indicator in auto-check, `/listcheck`, `/search`, `/roster`. Alt match via roster displays "via **TrustedName**".
- Raid tag shown in auto-check flagged output.
- Clickable 📎 evidence links in `/list view`.

### Changed

- All slash commands now use `setDMPermission(false)`.
- Scope priority `server > global` applied consistently across read paths.
- `/search` uses `$in` batch queries (~4 queries instead of ~60 for 15 results).
- Approval payload carries scope + logs + action + duplicate context through the full round-trip.
- `/list edit` uses cross-list move (create-before-delete with preflight dedup) + duplicate overwrite is update-in-place.
- Similar-name cache stores candidate names only; flags recomputed per-request for scope safety.
- Default blacklist scope: `global` (was `server`).

## [v0.4.0] - 2026-03-28

### Added

- `/list edit` for existing entries (owner/officer instant, members via approval); supports moving between lists.
- Quick Add dropdown + modal on auto-check results to add unflagged names directly.
- `/roster deep:true` runs Stronghold alt detection even when roster is visible.
- `/lasetup autochannel` / `notifychannel` / `view` / `reset` — per-guild channel config (`GuildConfig` model).
- `RosterCache` model (TTL 24h) to cache roster check results.
- Smart ScraperAPI fallback cache — remembers Cloudflare blocks for 5 minutes.
- Progress "Checking N name(s)…" message on auto-check.
- Gemini non-JSON + 404 model failover; thinking parts filter.
- Batch DB queries for list check (~35 → ~7 queries / check, ~80% reduction).
- Per-user 10s auto-check spam cooldown.

### Changed

- Auto-check resolves channels dynamically per message (`GuildConfig` → env fallback).
- Broadcast notifications skip the origin server.
- Side-by-side duplicate compare embed with Overwrite / Keep Existing buttons.
- Display sort priority: ⛔ → ⚠️ → ✅ → ❓ → ⚪.

### Fixed

- `/roster` alt detection now checks `allCharacters` (not just `name`).
- Pending `/list add` approvals survive bot restart (persisted via `PendingApproval`).
- `lostark.bible` search API payload format compatibility.

## [v0.3.0] - 2026-03-20

### Added

- `/search name [min_ilvl] [max_ilvl] [class]` — similar-name scan on lostark.bible with cross-check.
- Cross-server list notification broadcasts on add / remove.
- `/list view` pagination (10/page) + 📎 evidence dropdown.
- `/lahelp` command listing.
- Watchlist (`/list add type:watch`) — ⚠️ "under investigation" list.
- `ilvl >= 1700` validation on `/list add`.
- Auto-check channel feature with multi-channel / multi-server support via `AUTO_CHECK_CHANNEL_IDS`.
- Multi-server monitoring via `TARGET_SERVERS` with a single page fetch.
- Stronghold-based alt detection when roster is hidden.
- Guild-member-list cross-check when roster is hidden.
- `RosterSnapshot` model for iLvl progression; `/roster` shows iLvl delta since last check.
- Auto-enrich `allCharacters` via background guild scan after a flagged hit.
- OCR similar-name suggestions for diacritic misreads.
- Fail reason displayed on roster lookup failure.

### Changed

- Approver IDs moved to env vars (`OFFICER_APPROVER_IDS`, `SENIOR_APPROVER_IDS`, `MEMBER_APPROVER_IDS`).
- Merged `/check` into `/status` (live check, removed cached command).
- `/lahelp` renamed from `/help` to avoid conflict with other bots.
- Replaced ScraperAPI primary with direct fetch + ScraperAPI fallback on 403/503.
- Sequential `findOne` loops replaced with `$in` batches across roster cross-checks.

## [v0.2.0] - 2026-03-19

### Added

- Image-driven `/listcheck` flow via Gemini OCR (hard limit 8 names).
- Gemini model failover priority list via `GEMINI_MODELS`.
- Approver-ID workflow for `/list add` proposals (DM Approve/Reject buttons) with auto-approve for officer/senior.
- Requester preview embed; synchronized DM state across approvers on approve/reject.
- `addedByDisplayName` audit field.

### Changed

- Refactored from monolithic `bot.js` into `bot/handlers/*` + `bot/services/*` + `bot/utils/*`.
- Roster output lines now include class info.
- Fixed weekly maintenance window: Wed 07:00 UTC → Thu 07:00 UTC.

## [v0.1.0] - 2026-03-17

### Added

- First tagged release. `/list add`, `/list remove`, `/listcheck` (text names, hard limit 7).
- `raid` option on `/list add` with predefined choices.
- `addedByUserId` / `addedByTag` audit fields.
- `allCharacters` roster snapshot on entries for cross-match.
