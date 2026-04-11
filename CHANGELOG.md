# Changelog

All notable changes to this project are documented here.

## [v0.5.6] - 2026-04-11

### Changed

- **`/list edit` success response is now a rich embed instead of plain text.** The previous response was a single line with a bullet list of changes (`✅ Daivuong edited in blacklist. • Scope: server → global`). The new response is a color-coded embed with the list icon in the title (`✏️ ⛔ Blacklist (Local) — Edited`), structured fields for name (with roster link), reason, raid, a `Changes (n)` field, the editor's name in the footer, a timestamp, and the freshly-resolved evidence image when one exists. Matches the visual style of `/list add` success and `/list view` evidence dropdown previews.
  - **New shared helper:** `buildListEditSuccessEmbed(entry, options)` at module level. Used by both the auto-approve path and the approval execution path so single-add edits and Senior-approved edits look identical to the requester.
  - **Approval path derives the change list** by comparing the `PendingApproval` payload to the pre-edit snapshot of the entry. The original edit command's `changes` array doesn't survive the round-trip through DB, so the comparison is reconstructed at approval time. Covers reason, raid, logs, evidence, type change, and scope change.
  - **Resolves a fresh evidence URL** via `resolveDisplayImageUrl(entry, client)` after the entry is materialized (cross-list move) or merged (in-place update). For rehosted entries this fetches a freshly-signed URL from the evidence channel, so the embed image is guaranteed valid even if the user edited the entry hours after the original upload.
  - **Cross-list move title:** `"Edited & Moved"` instead of `"Edited"` to make the move obvious. In-place edits keep the simpler `"Edited"` title.
  - **No-changes safety:** if `changes.length === 0` (shouldn't happen given the no-effective-changes guard from v0.5.5, but defensive), the helper omits the `Changes` field rather than rendering an empty bullet list.

## [v0.5.5] - 2026-04-11

### Added

- **`/list edit scope:` option** — promote a local blacklist entry to global, or demote a global one to server-only, without losing the entry's history (`addedAt`, `addedBy`, `allCharacters` snapshot, evidence). Previously the only workaround was `/list remove` followed by `/list add` with the new scope, which lost all metadata. Only meaningful for blacklist entries; using `scope:` on whitelist/watchlist edits is rejected with a clear error since those lists are always global by design.
  - **Auto-approve logic now uses target state, not current state.** Demoting global → server is a privilege de-escalation and auto-approves. Promoting server → global is a privilege escalation and goes through Senior approval (unless the editor is already an officer). Editing a local entry without changing scope continues to auto-approve as before.
  - **Conflict detection** — preflight query catches the case where the target `{name, scope, guildId}` combination would collide with an existing entry (e.g., demoting "X" from global to local in server A, but a local "X" already exists in server A). Rejects with an actionable error message. The Mongoose unique index also catches race conditions via `E11000`, returning a friendlier message.
  - **Broadcast routing follows the final scope.** A demote-to-local edit now broadcasts only to the owner guild (no spam to other servers); a promote-to-global edit broadcasts to all opted-in servers, even if the entry was previously local.
  - **No-effective-changes guard** — if the user provides `scope:` but it matches the current scope and no other fields are being edited, the command rejects rather than silently emitting a misleading "edited" success message.
  - Available in both auto-approve path (officer/senior/local-scope edits) and approval path (member edits requiring Senior sign-off). The approval payload carries the new scope through `PendingApproval.scope` and the approval handler honors it on apply.

## [v0.5.4] - 2026-04-11

### Fixed

- **P2: Approval-delayed `/list add` reused stale URL snapshot in success embed and broadcast.** When a member submitted an add with an image and Senior approved hours or days later, `executeListAddToDatabase` correctly persisted the entry with rehost refs but the success embed and broadcast embed both still called `setImage(payload.imageUrl)` — using the URL snapshot captured at submit time, not the entry's current rehosted state. If the gap was >24h, requester reply and broadcast embeds showed broken image links even though the underlying DB record was permanent. Fixed by resolving a fresh URL via `resolveDisplayImageUrl(entry, client)` immediately after `Model.create()` and using that for both the result embed and the broadcast. `broadcastListChange` now accepts a pre-resolved `displayUrl` option to avoid double-fetching the same evidence message.

### Added

- **`📎 View Evidence (Fresh)` button on `/list add` and `/list edit` approval DMs.** Approval DMs can sit unread for hours or days, by which time the embed image URL captured at submit time has expired and the inline preview is broken. The new button (only shown when the request has any image attached) re-resolves a freshly-signed URL on click — via the rehosted message for v0.5.2+ entries, or the legacy URL with a "may have expired" footer for older requests — and replies ephemerally with a guaranteed-fresh preview. Restricted to assigned approvers via the same `approverIds` permission check as Approve/Reject. New routing in `bot.js` dispatches `listadd_viewevidence:` button presses to `handleListAddViewEvidenceButton`. Addresses Senko's P3 finding about approval embed UX after the rehost feature.

## [v0.5.3] - 2026-04-11

### Fixed

- **P1: Approval-backed evidence silently lost rehost permanence.** `PendingApproval` schema only had `imageUrl`, so when `/list add` or `/list edit` flowed through Senior approval, Mongoose silently stripped the `imageMessageId`/`imageChannelId` fields from the saved payload. When the approver later clicked Approve, `executeListAddToDatabase` received undefined refs and fell back to storing only `imageUrl` — exactly the expiring CDN path v0.5.2 was meant to eliminate. Fixed by adding `imageMessageId` and `imageChannelId` to the `PendingApproval` top-level schema and to the `bulkRows` subschema.
- **P1: `/list multiadd` member approval rehosted at the wrong time.** The bulk loop only rehosted at execution time inside `executeBulkMultiadd`, but the member approval flow persisted only the raw user URL into `bulkRows`. If Senior approved hours later, the user-supplied Discord CDN URLs could already be dead before rehost ran. Fixed by rehosting rows **at submit time** (during the member's Confirm click) inside `handleMultiaddConfirmButton`, persisting refs into `bulkRows`. `executeBulkMultiadd` now skips rehost if a row already carries refs from the submit-time pass.
- **P2: `/search` and `/roster` did not display rehosted evidence.** Both commands treated `entry.imageUrl` as the only source of truth, but new rehosted entries intentionally store an empty `imageUrl`. Result: evidence images for any post-v0.5.2 entry disappeared from these commands. Fixed by adding `entryHasImage()` detection and `resolveDisplayImageUrl()` resolution in `searchHandler.js`, and by extending `rosterService.js` to return rehost refs and `rosterHandler.js` to call `resolveDisplayImageUrl()` before rendering evidence embeds.
- **P2: `/list edit` approval/in-place/overwrite paths regressed rehosted entries to URL-only storage.** Three write paths in `listHandlers.js` (cross-list move, in-place update, duplicate overwrite) only persisted `imageUrl`, dropping `imageMessageId`/`imageChannelId` even when the payload carried valid refs. Each path now writes all three image fields atomically: rehost refs preferred, legacy URL as fallback, existing entry's image fields preserved when no new image was supplied.
- **P2: `/list edit` risked Discord 3-second interaction timeout on image edits.** The handler called `rehostImage()` (download + upload, can take 1-3s) before `deferReply()`. Reordered so `deferReply()` runs first, matching the safer pattern already used by `/list add`.

## [v0.5.2] - 2026-04-11

### Fixed

- **P1: Discord CDN evidence images expired silently after ~24h.** Since 2024, Discord CDN attachment URLs include signed expiry tokens (`?ex=...&hm=...`). The bot was storing those URLs directly, so any `/list add image:` evidence silently 404'd a day later. Confirmed in production: 3 entries (Razed/Veska/Endlessbless) lost evidence ~44h after add. Fixed by introducing an evidence rehost mechanism — bot now re-uploads each image to a dedicated "evidence channel" and stores the message ID instead of the URL. On display, bot fetches the message via Discord API and reads a freshly-signed attachment URL (Discord re-signs on every fetch). Future entries are permanent; legacy entries stay broken (cannot recover expired URLs).
- **`/list view` crashed with `ReferenceError: refreshImageUrl is not defined`.** The earlier 📎 link refactor added a call to `refreshImageUrl()` inside `buildPage` but did not add the function to the imports at the top of `bot/handlers/listHandlers.js`. ESM does not validate identifier references until execution, so the file loaded fine and the bug surfaced only when a user actually invoked `/list view`. Fixed by adding `refreshImageUrl` to the existing `imageRehost.js` import line.

### Added

- **`/laremote action:evidencechannel channel:#...`** — Senior-only command to set the bot-wide evidence channel where rehosted images are stored. Persists to owner guild's `GuildConfig.evidenceChannelId`. Updates instantly without redeploy. Validates that the bot has View/Send/AttachFiles/ReadHistory permissions in the chosen channel before saving. Visible on the `/laremote action:view` dashboard owner card.
- **`bot/utils/imageRehost.js`** — new zero-dep helper module exporting:
  - `rehostImage(originalUrl, client, meta)` — downloads URL, uploads to evidence channel with audit metadata in message content (entry name, added by, timestamp), returns `{ messageId, channelId, freshUrl }` or `null` on failure.
  - `refreshImageUrl(messageId, channelId, client)` — fetches stored message and returns the fresh signed attachment URL.
  - `resolveDisplayImageUrl(entry, client)` — high-level helper that prefers rehosted refresh, falls back to legacy `entry.imageUrl`.
- **Schema fields:** `imageMessageId` and `imageChannelId` added to `Blacklist`, `Whitelist`, and `Watchlist`. Legacy `imageUrl` is preserved as fallback for entries created before rehost.
- **`GuildConfig.evidenceChannelId`** — String field on the owner guild's config record (bot-wide setting, not per-guild).

### Changed

- `/list add` now rehosts the image attachment **immediately** after submission (while the original CDN URL is still valid) and stores the resulting `imageMessageId`/`imageChannelId` instead of the URL. If the evidence channel is not yet configured or rehost fails, falls back to legacy URL storage with a console warning.
- `/list edit` rehosts new image attachments the same way and properly carries over existing rehost refs when only other fields change.
- `/list multiadd` parser now rehosts each row's `image` URL during the bulk loop, so bulk uploads also get permanent storage.
- `broadcastListChange` and `/list view` evidence display use `resolveDisplayImageUrl` to fetch fresh URLs lazily for rehosted entries while gracefully falling back to legacy URLs.
- `/list view` paginated 📎 inline links now resolve a fresh CDN URL per page render. `buildPage` is async and runs `refreshImageUrl` for every rehosted entry on the current page in parallel via `Promise.all` (~10 fetches/page, <1s typical), then injects the fresh signed URL into the markdown link. Click → opens the actual image in browser/Discord viewer instead of jumping to the storage channel. Legacy entries still link to the (possibly expired) direct CDN URL. Pagination handlers `await i.deferUpdate()` before rebuilding to stay inside Discord's 3-second interaction window.
- `/list view` evidence dropdown now includes both legacy and rehosted entries; the ephemeral preview embed shows a clear "Image link expired" notice when refresh fails.
- `/laremote action:view` dashboard now shows the evidence channel setting on the owner guild card (with a warning if unset).

## [v0.5.1] - 2026-04-11

### Added

- **`/list multiadd`**: Bulk add entries via Excel template — anyone can use.
  - `/list multiadd action:template` — downloads a styled `.xlsx` template with 7 columns (`name`, `type`, `reason`, `raid`, `logs`, `image`, `scope`), dropdown validation for `type` and `scope`, a yellow example row, 5 placeholder rows with borders, frozen header, auto-filter, and an Instructions sheet.
  - `/list multiadd action:file file:<upload>` — downloads and parses filled template, shows a preview embed with up to 20 valid rows and the first 10 validation errors. Preview has **Confirm / Cancel** buttons that expire after 5 minutes.
  - Max **30 rows** per file, max **1 MB** file size, `.xlsx` only.
  - Validation rules: required fields (`name`, `type`, `reason`), type enum (`black`/`white`/`watch`), URL format for `logs`/`image`, scope enum (`global`/`server`), intra-file duplicate detection (case-insensitive), scope auto-stripped for non-blacklist entries.
  - Reuses existing `/list add` logic (trusted guard, roster fetch, ilvl check, scope-aware duplicate check) — no divergence of rules.
  - **Bulk approval flow** for members: if requester is not an officer/senior, the batch is sent as a single `PendingApproval` with `action: 'bulk'` to all configured approvers. Senior gets **one DM** with full preview + Approve/Reject buttons (no spam per row). Reject and approve both notify the original requester in the origin channel.
  - Officer/senior users bypass approval and execute immediately.
  - **Single bulk broadcast** — one embed summarizing all added entries (grouped by list type), not N separate broadcasts. Global entries broadcast to all notify channels; server-scoped entries broadcast only to owner guild with `(Local)` tag.
  - Per-row throttle of 200ms to avoid hammering lostark.bible.
  - Progress updates every 5 rows during direct execution (officer path).
- `exceljs@^4.4.0` dependency for Excel template generation and parsing.
- New `bot/utils/multiaddTemplate.js` module — exports `buildMultiaddTemplate`, `parseMultiaddFile`, `MULTIADD_MAX_ROWS`. Zero dependencies on Discord/DB/config so it's independently testable.
- `PendingApproval.bulkRows` array field — stores parsed multiadd rows for bulk approval flow. `type` and `name` are now conditionally required (only for single add/edit).
- `PendingApproval.action` enum now includes `'bulk'` alongside `'add'` and `'edit'`.

### Changed

- `executeListAddToDatabase` now honors `payload.skipBroadcast` (used by bulk flow to defer broadcasting) and returns the created `entry` Mongoose doc in the success result so callers can use it for bulk broadcast.
- `broadcastListChange` channel resolution logic extracted into `resolveBroadcastChannels` helper and reused by the new `broadcastBulkAdd` function. Behavior identical — just factored out to avoid duplication.

### Fixed

- **P1 race condition** in `handleMultiaddApprovalButton`: replaced `findOne` + `deleteOne` with atomic `findOneAndDelete`, preventing double execution when two approvers click Approve simultaneously.
- **P2 auto-approve scope mismatch**: `/list multiadd` now uses a stricter `isOfficerOrSenior()` check instead of `isRequesterAutoApprover()`, so `MEMBER_APPROVER_IDS` can no longer bypass bulk approval. Matches the README claim that only officers/seniors skip approval. Single `/list add` behavior unchanged.
- **P2 bulk approval must be Senior-only**: `sendBulkApprovalToApprovers` now uses a new `getSeniorApproverIds()` helper instead of `getApproverRecipientIds()`, so bulk approval DMs go to every Senior (never a random officer). The placeholder `approverIds` in `PendingApproval.create` is also scoped to the same Senior-only list to prevent divergence between DM recipients and the permission check.
- **P3 stale approver DMs**: after one Senior approves/rejects a bulk batch, `handleMultiaddApprovalButton` now calls `syncApproverDmMessages` in both branches to edit the OTHER approvers' DMs (excluding the clicking approver) so their buttons disappear instead of staying active until a second click reveals the request is gone.
- **Progress callback logic** in officer bulk add path: `||` → `&&` so the final "N/N rows done" update actually fires at the end of the loop.
- **Orphan DMs on DB failure** in member bulk approval flow: restructured to (1) look up target approvers, (2) create PendingApproval with full target list up front so early clicks pass permission check, (3) send DMs, (4) trim `approverIds` to only successfully delivered. If 0 deliveries or any step fails, the placeholder record is cleaned up via `deleteOne`.
- **Missing `requesterName`** in `multiaddPending` entries: now populated from `interaction.user.username` so created entries have non-empty `addedByName` audit field.
- **Slash command description inconsistency**: `/list multiadd` description updated from "officers/seniors only" (wrong — handler allows everyone) to "officers auto, members via Senior approval" (matches actual behavior).

## [v0.5.0] - 2026-04-08

### Added

- **Server vs Global blacklist**: Blacklist entries now have `scope` field — `global` (shared across all servers) or `server` (per-guild only). Server-scoped entries are not broadcast to other servers.
  - `/list add` has new `scope` option (global/server) for blacklist entries.
  - `/list view` has new `scope` filter (all/global/server) — owner server can view all server-scoped entries from every guild with `(Local: ServerName)` labels; other servers only see their own.
  - `OWNER_GUILD_ID` env var identifies the owner/admin server.
  - Auto-check, roster, and search all scope-aware.
  - `Blacklist.syncIndexes()` on startup to migrate from old `name`-only index to compound `{name, scope, guildId}` index.
- **`/lasetup off`**: Toggle global list notifications on/off per server (replaces `/lasetup reset`). Running again re-enables. `/lasetup notifychannel` auto-enables. `/lasetup view` shows 🔔/🔕 status.
- **`/lasetup defaultscope global/server`**: Set default blacklist scope per guild. When `/list add type:black` is used without specifying scope, defaults to guild setting (default: `global`). Quick Add also respects this setting. `/lasetup view` shows current default scope.
- **Show raid info in auto-check**: When a name is flagged, the raid tag from the entry is now displayed in auto-check results (e.g. `⛔ Name — reason — [G6 Aegir]`).
- **Clickable evidence 📎**: Evidence icon in `/list view` is now a clickable markdown link that opens the image directly.
- **Trusted user list**: New `TrustedUser` model — trusted characters cannot be added to the blacklist.
  - `/list trust action:add name [reason]` — add to trusted list (officer/senior only).
  - `/list trust action:remove name` — remove from trusted list.
  - `/list view trusted` — view all trusted users.
  - Guard checks both exact name and roster alts — trusted users cannot be added to any list (blacklist, whitelist, or watchlist).
- Added `GuildConfig.globalNotifyEnabled` field for per-guild notification toggle.
- Added `TrustedUser` model with officer-only management.

### Changed

- `/lasetup reset` replaced by `/lasetup off` (toggle notifications instead of deleting config).
- Blacklist model now has `scope` (global/server) and `guildId` fields with compound unique index.
- All blacklist queries (list check, roster, search, view, edit, remove) are scope-aware.
- Server-scoped blacklist entries are not broadcast to other servers.
- Owner guild can view all server-scoped entries from every guild with server name labels.
- `/list view` scope filter available for blacklist type.
- All slash commands now have `setDMPermission(false)` — bot commands are hidden in DMs.
- `PendingApproval` schema expanded: `scope`, `logsUrl`, `action`, `existingEntryId`, `currentType`, `duplicateEntryId` to preserve full context through approval flow.
- Edit approval uses separate path from add — updates entry by `_id`, preserves scope.
- Overwrite duplicate is now update-in-place (no delete-then-add risk). Preserves scope, refreshes roster only on valid fetch, shows `[Global]`/`[Server]` scope labels in compare embed.
- Move list uses create-before-delete order with preflight scope-aware duplicate check.
- Trusted guard rechecked at approval time; `/list trust` blocks if character already blacklisted (scope-aware).
- Similar-name cache stores candidate names only — flags recomputed per-request for scope safety.
- Broadcast query reads all GuildConfigs for opt-out detection (not just notify-configured ones).
- Server-scoped (local) blacklist entries auto-approve — no officer approval needed.
- Server-scoped blacklist broadcast to owner guild only (with `(Local)` tag); other servers don't receive.
- Owner guild auto-check/search/roster sees all server-scoped entries from every guild.
- Scope priority `server > global` applied consistently across all read paths (map build, findOne sort).
- `/search` uses batch `$in` queries (4 queries instead of 60 for 15 results).
- Removed debug `Blacklist.countDocuments()` from roster hot path.
- `fetchNameSuggestions` returns `null` on API error (vs `[]` for no results) — `/search` shows "lostark.bible unavailable" instead of misleading "No results".
- 🛡️ Trusted indicator shown in auto-check, `/listcheck`, `/search`, `/roster` results (exact + alt detection via allCharacters).
- Trusted alt detection: "via **TrustedName**" shown when match is through roster.
- Extracted `bot/utils/scope.js`: shared `buildBlacklistQuery()`, `isOwnerGuild()`, `getGuildConfig()` (60s cache), `invalidateGuildConfig()`.
- Default blacklist scope changed to `global` (was `server`).
- `/lasetup` ManageGuild permission checked in handler (not command-level) to allow all subcommands to be visible.

## [v0.4.0] - 2026-03-28

### Added

- Added `/list edit name [reason] [type] [raid] [logs] [image]` — edit existing list entries. Owner or officer can edit immediately; others go through approval flow. Supports moving entries between lists (type change).
- Added Quick Add from auto-check — dropdown to select unflagged names → Modal (type/reason/raid) → add to list directly from check results.
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
- Duplicate handling on approval: side-by-side comparison embed + Overwrite/Keep Existing buttons.
- Batch DB queries: list check reduced from ~35 to ~7 queries per auto-check (80% reduction).

### Changed

- Auto-check now resolves channels dynamically per message: checks DB `GuildConfig` first, falls back to `AUTO_CHECK_CHANNEL_IDS` env var. No bot restart needed after `/lasetup`.
- DB notify channels override env vars when configured via `/lasetup` (no longer merged).
- Broadcast notifications skip the origin server (user already sees the reply).
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