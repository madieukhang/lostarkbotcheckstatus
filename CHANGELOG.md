# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates use the local calendar of each release.

This changelog focuses on user-visible changes, important backend fixes, and structural milestones. Deep implementation notes belong in commit messages or internal review docs.

## Unreleased

### Added
- `/la-evidence name [public]` direct-lookup command. Autocomplete unions Blacklist/Whitelist/Watchlist by name prefix (case-insensitive, latest-added first when input is empty) and returns up to 25 `<type>:<name>` value choices so the handler picks the right list even when the same name exists across types. Reuses `buildEvidenceEmbed` from `/la-list view` so the rendered card stays visually consistent.
- Permission shape: ephemeral by default (member-visible); `public:true` is gated to officer/senior so only privileged users can broadcast evidence into the channel. Members who pass `public:true` get a soft "Public Mode Restricted" alert prepended to a still-ephemeral reply rather than a hard reject. Officer-only "Added by" footer matches the existing `/la-list view` evidence detail behavior.
- `bot/utils/rosterLink.js` centralises the four character-page display URL shapes (`rosterUrl`, `logsUrl`, `profileUrl`, `guildPageUrl`). New `config.bibleBaseUrl` (env `BIBLE_BASE_URL`, default `https://lostark.bible/character/NA/`) drives all four. Swapping the upstream roster site no longer means grepping ~25 files. Data-fetch URLs (`__data.json`, `/guild/__data.json`) intentionally remain controlled by the scraper/worker layer since those are bible-as-data-source, decoupled separately by the local-sync project.

### Changed
- All in-embed character-page links (`/la-list view` Tracked alts, `/la-list view` evidence detail, `/la-search` result rows, `/la-list add` success card with Roster + Logs buttons, `/la-list remove` Tracked alts, `/la-list trust` Added/Removed cards, `/la-list enrich` Newly tracked block, `/la-roster deep` scan-result/progress/completion DM, hidden-roster embed title) now route through the `rosterLink.js` helpers. Default URL output is unchanged from prior production behavior. `bot/services/multiadd/template.js` keeps its hardcoded example URL on purpose to preserve the module's zero-deps property (per its docstring).
- Cross-server list add/edit broadcasts now render tracked alts with class icon, item level, and CP when roster data is available. Rows still fall back to linked names when a snapshot is missing.

### Fixed
- OCR list-check and auto-check are now DB-only after OCR: they compare extracted names against blacklist/whitelist/watchlist/trusted data and stored snapshots only. They no longer call bible, worker roster lookup, hidden-roster fallback, similar-name search, or post-check roster enrichment.

### Tests
- Added focused coverage for the richer tracked-alt broadcast formatter.
- Added coverage that OCR list-check stays DB-only and renders unmatched names as `not listed`.

## [v0.5.81] - 2026-05-05

### Changed
- `/la-help` rebuilt around the same drill-down pattern RaidManage's `/raid-help` uses: initial reply renders **one** overview embed plus a section dropdown; selecting an option swaps the embed in place via `interaction.update`. Replaces the previous "dump 2-3 embeds at once" reply that intermittently hit Discord's ~6000-char cross-embed text cap on the owner-guild path (`embeds[MAX_EMBED_SIZE_EXCEEDED]`).
- Sections offered by the dropdown: Command list (default / overview), `/la-list multiadd` detail, and `/la-remote syncimages` detail (owner guild only). Picking any option re-renders the same ephemeral message; the dropdown sticks around so users can hop between sections without re-running `/la-help`.
- Language is baked into the dropdown's `customId` (`la-help:select:<lang>`) so a user who picked `lang:vn` gets VN-language details on every dropdown selection, even if a separate command run elsewhere chose `lang:en`. Mirrors RaidManage's pattern.
- Discard the prior reply + followUp split (`v0.5.80` patch). The drill-down approach keeps each rendered message strictly one embed, well under the 6000-char ceiling regardless of guild scope.
- Minor `bot.js` wire-up: added `interaction.isStringSelectMenu() && customId.startsWith('la-help:select:')` dispatch to `handleHelpSelect`.

### Notes
- 83/83 tests pass. No new help-specific tests; existing test suite covers the broader command surface and the new code paths are pure render functions plus a thin Discord interaction wrapper.
- Help content unchanged: same overview command list, same multiadd guide, same syncimages guide. Only the **delivery shape** differs (drill-down dropdown instead of stacked embeds).

## [v0.5.80] - 2026-05-05

### Changed
- Anti-detection tweaks for the Stronghold deep scan now that Phase 3 cutover is live and producing real bible traffic.
- `FETCH_HEADERS` adds a `Referer: https://lostark.bible/` header. Real browser navigation always sets Referer; sending bible API requests with no Referer at all stands out from regular traffic. Homepage is a generic "just landed" approximation that does not require per-request bookkeeping.
- `detectAltsViaStronghold` inter-candidate sleep is now jittered +/- 15% (0.85x to 1.15x of `backoff.current`). The previous fixed-pace cadence was a clock signal anti-bot heuristics can pattern-match; jitter breaks the periodicity without changing the average rate.
- Backoff response on HTTP 429 changed from linear addition (`current + 1500 * retries`) to multiplicative growth (`current * 1.6^retries`). Production scan against Bullet Shell on 2026-05-05 (294 candidates, 10x 429) proved the linear ramp recovered too predictably. Multiplicative growth doubles the gap on consecutive rate-limits, matching the pace bible's app-level limiter expects when it fires.

### Notes
- 83/83 tests pass. No new tests for jitter directly (randomness is hard to assert); existing detector tests continue to verify backoff bounds and abort flows.
- Compounding effect: next time the scan retries Bullet Shell, expect slightly fewer 429s in a long scan because the jittered cadence and stronger 429 backoff give bible's limiter more headroom. Latency per candidate may rise slightly during cool-off windows, but the trade is "fewer detection signals" for "marginally slower scan."
- Phase 4 surface UI (`/la-status` worker heartbeat, DM alerts, PM2 / Windows scheduled task auto-restart) still pending. Anti-detection is the most urgent slice given user concern about long-term flagging.

## [v0.5.79] - 2026-05-05

### Changed
- Hard gate: `/la-list enrich` and `/la-roster deep:true` are now restricted to officers/seniors. Non-privileged users see an ephemeral "Officers / Seniors only" embed explaining that the command depends on the bot owner's residential-IP worker. Plain `/la-roster name` (without the deep flag) stays open to everyone.
- Same gate applies to the "Enrich now" button posted on `/la-list add` success cards for hidden-roster entries: the button is visible to anyone but pressing it as a non-privileged user gets the same denial embed (the worker-mode dependency is identical to the slash command).
- Worker-offline error message reworded from `Scraping worker offline (...). Start loa-worker.js and try again.` to `Stronghold lookup service is offline (...). The bot owner's residential-IP worker is not running. Try again in a few minutes or ping the bot owner to start their local worker.` Reads better when the error surfaces in a Discord embed for an officer who is not the operator.
- Help embed (`/la-help`) and `README.md` command tables now flag enrich + roster deep as officers/seniors only.

### Notes
- 83/83 tests pass. One worker-bible-client assertion updated to match the new offline message string.
- Behavior change rationale: with worker mode pending Phase 3 cutover, the heavy commands have a hard dependency on a single residential-IP host. Restricting them to officers/seniors prevents regular users from running into a confusing "service offline" error every time the operator's PC is off, while keeping the commands accessible to the people who can coordinate with the operator.
- Continue / Confirm / Discard buttons on enrich and deep-scan result cards inherit the gate via session-ownership checks (only the original officer who started the scan can press them).

## [v0.5.78] - 2026-05-05

### Changed
- Phase 2 of local-worker migration. Adds dark-by-default hardening primitives that activate alongside Phase 1's worker mode. Thresholds shipped with best-guess defaults; needs adjustment after first real `/la-list enrich` run surfaces production numbers.
- New `bot/models/WorkerHeartbeat.js` schema (`worker_heartbeats` collection, single doc per `workerId`). Worker upserts `lastSeenAt: now()` every 15s; bot reads via `getWorkerHealth()`.
- New `bot/services/worker/heartbeat.js` exposes `startHeartbeat({ intervalMs })` and `stopHeartbeat(handle)` for the worker process, plus `getWorkerHealth({ maxStaleMs })` for the bot. Default stale threshold 30s = 2x the heartbeat interval, so a single missed tick is OK and two consecutive misses flip the state to offline. `getWorkerHealth` is DI-friendly (accepts `WorkerHeartbeat` model + `now` fn) so tests don't need a real Mongo.
- `loa-worker.js` calls `startHeartbeat()` after Mongo connect and `stopHeartbeat(handle)` on SIGINT, alongside the existing poll loop.
- `workerBibleClient.fetch` now runs a `countDocuments({ status: 'pending' })` check before insert. If pending count is at or above `WORKER_QUEUE_BACKPRESSURE_THRESHOLD` (default 100, env-tunable), the call throws "Scraping service overloaded" immediately rather than letting every caller eat the 30s timeout. Threshold is read at module load time; toggling requires a bot restart. Factory function accepts `backpressureThreshold` for test injection.

### Tests
- 7 new tests, 81/81 total pass.
- 5 new in `test/worker-heartbeat.test.js`: no-record offline, fresh heartbeat online, stale heartbeat offline, custom workerId isolation, exact-boundary inclusive.
- 2 new in `test/worker-bible-client.test.js`: backpressure rejects when queue at threshold, still inserts when below.

### Notes
- Surface UI (`/la-status` command, DM alerts) deliberately not wired in this commit. Once the first real `/la-list enrich` run produces queue depth + heartbeat latency data, those thresholds (DM-after-N-minutes, `/la-status` warning bands) can be tuned with grounding instead of guessing at 1 AM.
- Heartbeat doc has no TTL on purpose: a stale doc IS the diagnostic signal "worker offline since X". Manual cleanup not required; next worker start UPSERTs.
- Phase 3 cutover (set `BIBLE_WORKER_ENABLED=true` on Railway, start `loa-worker.js` on Traine's PC) is intentionally NOT in this commit. Manual production change, gated on awake/rested operator.

## [v0.5.77] - 2026-05-05

### Changed
- Phase 1 of local-worker migration. `bibleClient.fetch(url, options)` now routes based on two conditions: the bot-level kill switch `BIBLE_WORKER_ENABLED` (parsed as boolean, off by default), AND the per-call opt-in flag `options.viaWorker === true`. Both must be true to delegate to `workerBibleClient`; otherwise the call goes through `fetchWithFallback` as before. Production behavior is unchanged until both the env var is on and the call site explicitly opts in.
- Worker scope is intentionally narrow: only the heavy fan-out commands `/la-list enrich`, `/la-roster deep` (visible), `/la-roster` hidden-roster fallback, the Continue-resume button, and the optional post-OCR auto-enrich pass `viaWorker: true`. Latency-sensitive callers (autocomplete search, `/la-list add` single fetch, top-level `/la-roster` page fetch) stay on direct fetch even when worker mode is enabled, so the bot's UX doesn't collapse from per-keystroke Mongo round-trips.
- New `bot/models/ScrapeJob.js` schema with 1-hour TTL on `createdAt`. Stores `url`, `options.timeoutMs`, `status` (pending/in_progress/done/failed), `result.{status,headers,body}`, and `error`. Headers stored as `Map<String, String>`.
- New `bot/services/roster/workerBibleClient.js` exposing `createWorkerBibleClient({ ScrapeJob, pollIntervalMs, defaultTimeoutMs, now })` for DI-friendly tests, plus a default singleton wired to the production model. Reconstructs a real `Response` object from the Mongo-stored body/status/headers so upstream callers (which all use `bibleClient.fetch(url)`) need no changes.
- New `bot/services/scrapeWorker.js` exports `claimAndProcessOne()` and `claimNextJob()`. Pure functions, no top-level side effects. Tests can drive a single iteration without spawning a worker process; the standalone `loa-worker.js` calls `claimAndProcessOne` in its poll loop.
- New `loa-worker.js` standalone at repo root. Connects to MongoDB via `process.env.MONGODB_URI`, runs the poll loop, sleeps 1s on idle. Uses `FETCH_HEADERS` from new `bot/services/roster/bibleHeaders.js` (config-free module so worker never drags in `bot/config.js` and its DISCORD_TOKEN/CHANNEL_ID validation). THIN headers verified 10/10 pass from residential IP on 2026-05-04.
- `buildBibleFetchOptions` now forwards `viaWorker` and `timeoutMs` so the option propagates from upstream callers (enrich, deep, hidden roster, deepContinue, listCheckEnrichment) through the existing fetchCharacterMeta / fetchGuildMembers / detectAltsViaStronghold chain to bibleClient. The candidate-loop fan-out inside altDetection inherits `viaWorker` from the same options bag so all 437+ candidate fetches per scan ride the worker.

### Tests
- New `test/loa-worker.integration.test.js` uses `mongodb-memory-server` (devDependency) to spin up an in-memory MongoDB per test session. Verifies the full Mongoose round trip (insert -> claim -> fetch -> update -> read back) without ever touching production. fetch is stubbed; the goal is to verify worker mechanics + Mongoose Map<>Object header conversion + state transitions.
- 5 integration cases: idle when no jobs, processes pending and writes done, marks failed when fetch throws, picks oldest pending first, ignores non-pending jobs.
- 5 existing unit tests for `workerBibleClient` still cover the bot side (happy path, failed job, timeout, options sanitization, missing-job/TTL).

### Notes
- 74/74 tests pass (69 prior + 5 new integration). End-to-end smoke run against real bible from a residential IP on 2026-05-05: 662ms total round trip (queue 229ms + worker fetch 433ms), HTTP 200 returned, Mongoose Map header serialization round-trips cleanly.
- `BIBLE_WORKER_ENABLED` is read at module load time; toggling requires a bot restart. Setting it to anything other than `1`/`true`/`yes`/`y`/`on` (case-insensitive) leaves worker mode off.
- Phases 2-4 (hardening, prod cutover) intentionally not bundled with Phase 1. After deploy + a real `/la-list enrich` run with worker mode, the latency / success / queue depth observed in prod will inform Phase 2 design.

## [v0.5.76] - 2026-05-04

### Changed
- Introduced `bot/services/roster/bibleClient.js` as the single chokepoint for outbound bible requests. Phase 0 of the local-worker migration: behavior is unchanged (pass-through to `fetchWithFallback`), but all upstream callers now go through one indirection so Phase 1 can plug in a worker-queue transport without touching handler/service code.
- Migrated 6 call sites from `fetchWithFallback()` to `bibleClient.fetch()`: `characterMeta.js`, `guildMembers.js` (×2), `search.js`, `buildRosterCharacters.js`, and `handlers/roster/command.js`. `rosterService.js` re-exports `bibleClient` alongside the existing `fetchWithFallback` export.

### Notes
- 64/64 tests pass. Test suite still imports `fetchWithFallback` directly to exercise the implementation - kept exported.
- Direct fetch from Railway is currently 100% rejected by Cloudflare on the bible domain (datacenter IP scoring); local residential IP passes 10/10. Phase 1 will route bible traffic through a residential-IP sidecar via MongoDB job queue so the bot never hits CF directly.

## [v0.5.75] - 2026-05-04

### Fixed
- Auto-check now deduplicates each Discord message before the async channel-config lookup. This prevents one uploaded screenshot from producing two result cards when Discord delivers duplicate `messageCreate` events or the listener is accidentally attached twice in one bot process.

## [v0.5.74] - 2026-05-04

### Fixed
- Trusted-status indicator changed from 🛡️ to 💚 in OCR check rendering. The shield emoji collided visually with the Paladin / Valkyrie class icons (whose PNG art is a literal shield), producing a "two shields stacked" look on those classes' rows. The new green-heart icon is semantically equivalent (approved / loved) and visually distinct from every class icon.

### Changed
- Direct-match trusted rows (name equals the trusted entry name) now surface `· trusted` as an inline suffix on the main row instead of an empty branch. Via-match trusted rows keep the existing branch line (`   ↳ via Other · trusted`) for context.

### Notes
- 57/57 tests pass.
- Outcome breakdown line + `formatResultLine` both updated; the change is consistent across the embed header and the per-name list.
- Other surfaces still use 🛡️ shield as the trusted icon (it remains unambiguous when not stacked next to class art).

## [v0.5.73] - 2026-05-04

### Changed
- **OCR check card decluttered.** Three layers of redundancy collapsed:
  - The per-status breakdown line (`⚠️ 1 · ✅ 1 · 🛡️ 2 · ❓ 4`) was being emitted twice: once as the `Outcome:` header by `buildListCheckEmbed`, and once again by `formatCheckResults` as a stand-alone summary above the per-name list. Removed the second copy; only the bolded `Outcome:` header survives.
  - The 3-up stats panel (Checked / Flagged / Cleared) below the description carried the same aggregate counts in a different shape. Dropped from the embed; the `Outcome:` header already conveys all the numbers an officer needs at a glance.
  - Branch sub-lines (`   ↳ ⛔ via Apakkbreak · ...`) repeated the list-status icon already shown on the main row above. Branch now reads `   ↳ via Apakkbreak · *reason* · [raid]` without the redundant glyph.

### Notes
- 57/57 tests pass.
- Net effect: typical 8-name auto-check card is now ~30% shorter vertically with no information loss · the description carries Outcome breakdown + per-name lines + branch context, the footer carries the call-to-action and source citation.

## [v0.5.72] - 2026-05-04

### Fixed
- Class extraction in `buildRosterCharacters` was silently failing for some names: ilvl + CP populated but `targetClassName` came back null. Root cause: a duplicate inline DOM-walk + rosterClassMap lookup that drifted from the canonical parser. Refactored to call `parseRosterCharactersFromHtml` directly (the same proven function `/la-roster` uses) and pull the queried character's record from its output. Now className extraction matches the rest of the codebase and the OCR check renders class icons consistently.

### Changed
- **OCR check result lines** restructured for richer per-character context. Old layout inlined flag info next to the name (`⛔ **Apakksoul** · via **Apakkbreak** · reason · [Act4 Nor]`); new layout shows full character identity on the main row (`⛔ <:reaper:id> **Apakksoul** · \`1730\` · CP 3500`) with a sub-line branch for flag context (`   ↳ ⛔ via **Apakkbreak** · *reason* · [Act4 Nor]`). Same convention `/la-search` already uses for multi-line result rows.
- **Flagged entries** (blacklist / whitelist / watchlist) now go through Phase 2 roster lookup just like clean ones. Previously the lookup skipped them, leaving flagged rows without class / ilvl / CP. The data is the same backing the unflagged rows (`RosterSnapshot` snapshot + cache + fresh-scrape fallback).
- **Support classes sorted last** within each priority bucket (Bard / Paladin / Artist / Valkyrie). DPS rows surface first so a raid leader scanning the card sees the DPS roster impact ahead of supports (which are easier to slot in at the same flag tier). Mirrors sister bot RaidManage's `SUPPORT_CLASS_NAMES` constant.

### Notes
- 57/57 tests pass.
- Party grouping (Party 1 / Party 2 split when an OCR'd image has 2 raid groups) is a known follow-up: requires Gemini OCR to surface spatial info per name. Tracked for a separate commit.

## [v0.5.71] - 2026-05-04

### Fixed
- OCR check (`/la-list check` + auto-check) was still rendering plain `❓ Name` for names that v0.5.70 should have decorated. Root cause: the v0.5.70 fix only fired in the cache-miss branch of `checkNamesAgainstLists`. Names previously checked (in `RosterCache` from any pre-v0.5.71 deploy) hit the cache-hit branch which short-circuited the fresh scrape, so class/ilvl/CP were never extracted. Fix: `RosterCache` schema gained `targetClassName / targetItemLevel / targetCombatScore` fields. Fresh scrapes now populate them; cache hits surface them onto `item.snapClassName / snapItemLevel / snapCombatScore` so `formatResultLine` renders the rich row. Pre-v0.5.71 entries that satisfy `hasRoster` but lack class data are treated as cache miss for one request so the next scrape backfills both cache + snapshot in one pass.

### Notes
- 57/57 tests pass.
- Snapshot data still wins over cache fields when both are present (snapshot is fresher because `/la-roster` writes it on every command, while cache TTL is 24h).
- Pre-v0.5.71 cache entries TTL out within 24h regardless; the re-scrape backfill just speeds the transition for actively-checked names.

## [v0.5.70] - 2026-05-04

### Fixed
- OCR check (auto-check + `/la-list check`) now shows class icon + ilvl + CP for **first-time names** too. v0.5.68 introduced the snapshot-based enrichment but only names previously queried via `/la-roster` had data; brand-new screenshots still rendered `❓ Anhsairoi` plain. Fix: `buildRosterCharacters` now exposes `targetClassName` + `targetCombatScore` extracted from the same roster page scrape that already runs during the OCR check (no extra fetch). The check service surfaces these onto the result item, overriding the snapshot lookup when the fresh scrape has data.
- Auto-snapshot: when fresh roster data is in hand, OCR check upserts `RosterSnapshot` with the same shape `/la-roster` writes. Subsequent OCR checks / search / broadcast lookups for the same name now hit the snapshot cache and render the class icon + CP without re-scraping.

### Notes
- 57/57 tests pass.
- Reverse-resolution display-name → bible classId via existing `resolveClassId`. Falls back to '' when a class isn't in the canonical `CLASS_NAMES` map (e.g. a new Smilegate release we haven't bumped yet); snapshot still gets ilvl + CP, just without classId.

## [v0.5.69] - 2026-05-04

### Added
- **`/la-search` results** carry class icon + CP per row. Old line `**1.** ⛔ [Name](link) · Bard · \`1740\`` becomes `**1.** ⛔ <:bard:id> [Name](link) · \`1740\` · CP 450,000`. CP sourced from `RosterSnapshot` join in the search handler; bible suggestions already carry the className (rendered via class icon).
- **Cross-server broadcast** (`broadcastListChange` single + `broadcastBulkAdd` bulk) carry class icon prefix on the headline name + ilvl + CP fields when `RosterSnapshot` has data. Recipients in other servers no longer have to run `/la-roster` to see the character context.

### Notes
- 57/57 tests pass.
- Single-broadcast adds two extra inline fields (📊 ilvl + ⚔️ CP) only when snapshot data exists; legacy entries without a prior `/la-roster` query still render the older minimal card.
- Bulk-broadcast does one batched `RosterSnapshot.find({ name: $in })` per dispatch; falls back to plain rows when snapshot missing for that name.

## [v0.5.68] - 2026-05-04

### Added
- OCR check results (`/la-list check` slash + auto-check passive) now show class icon + ilvl + CP per name when available. Pattern shifted from `❓ Anhsairoi` to `❓ <:bard:id> Anhsairoi · \`1740.83\` · CP 450,000`. Data sourced from `RosterSnapshot` (populated by prior `/la-roster` runs); names that have never been queried fall back to the previous unadorned line so brand-new screenshots still render.
- `RosterSnapshot` join added to `checkNamesAgainstLists` (one extra `find({ name: $in })` per request, batched). Each result item carries `snapClassName / snapItemLevel / snapCombatScore`; render sites read these via the new `formatResultLine` enrichment branch.

### Notes
- 57/57 tests pass.
- Class icon depends on the v0.5.67 emoji bootstrap; pre-bootstrap or an unmapped class falls back to the className text so the row still carries class info.
- Auto-check inherits the change automatically because it shares `formatCheckResults` + `buildListCheckEmbed` with the slash command.

## [v0.5.67] - 2026-05-04

### Added
- **Class icons** in scan / enrich / roster cards. Each character row now leads with a Discord application emoji of the class instead of the class name in text. Pattern shifted from `1. **Name** · Reaper · \`1750\`` to `1. <:reaper:id> **Name** · \`1750\``. Surfaces touched: scan progress card live alts, scan result card alt list, enrich Confirm success card, scan completion DM, `/la-roster` visible roster + top-char summary line.
- `bot/services/emojiBootstrap.js` (ESM port of RaidManage's class-emoji bootstrap). On bot Ready event the bootstrap mirrors PNGs in `assets/class-icons/` to Discord application emoji slots (content-addressed naming `{bibleId}_{md5short}` so a PNG content change auto-refreshes on next deploy), then populates `CLASS_EMOJI_MAP` (`bot/models/Class.js`) with the resulting `<:name:id>` strings keyed by display name. Idempotent: ~10s on first deploy, ~500ms on subsequent restarts (one GET + skip).
- 32 PNGs copied from `LostArk_RaidManage/assets/class-icons/`. 3 alias pairs (soulmaster/force_master, hawkeye/hawk_eye, plus the male/female form pairs Discord can't represent twice in one slot) collapse to a single emoji upload + shared ID via `CLASS_ALIAS_GROUPS`.

### Notes
- 57/57 tests pass.
- Failure mode: emoji bootstrap is non-fatal. If Discord blocks the upload (slot exhausted, REST hiccup), the bot keeps running; `getClassEmoji()` returns empty string for unmapped entries and the renderer falls back to the className text so the row still carries class info.
- Vocabulary parity with RaidManage: same `CLASS_NAMES` map, same alias groups, same content-hash naming so re-using emoji across bots is straightforward if we ever consolidate.

## [v0.5.66] - 2026-05-04

### Changed
- **Auto-check OCR result** (passive list check fired on image post in a configured channel) now renders as a structured embed instead of plain message content. Old layout was a flat `🔍 Auto-check: 2 name(s)\n\n❓ Anhsairoi\n❓ Ysylle` text block; new card has the same state-driven title icon, breakdown line, 3-up stats panel (Checked / Flagged / Cleared), and footer hint as `/la-list check`. The Quick-Add dropdown still ships below for unflagged names.
- Auto-check + slash check now share `buildListCheckEmbed` (`bot/utils/listCheckEmbed.js`) so the two surfaces stay in visual sync forever. `mode: 'auto'` vs `mode: 'slash'` only tweaks the title verb ("Auto-check" vs "List Check") and the footer copy (auto mentions the Quick-Add dropdown below the embed).

### Notes
- 57/57 tests pass.
- Closes the OCR family: every OCR-driven path (slash + passive auto-check) now follows the v0.5.65 vocabulary.

## [v0.5.65] - 2026-05-04

### Fixed
- Slash-command dispatcher now silences Discord transient interaction errors (`10062 Unknown interaction` and `40060 Interaction already acknowledged`) instead of dumping full stacks. Both happen when the 3-second initial-response window expires before deferReply lands (Railway redeploy with an in-flight slash command, websocket reconnect mid-handler, cold-start event-loop stall) or two paths race to ack the same interaction. The bot stays online and the user can retry; old behavior dumped the full stack at console.error level which buried genuine bugs in the deploy log. New behavior logs a one-line warning (`[bot] Transient on /la-list: Unknown interaction (3s window expired) (10062)`).

### Changed
- **UI vocabulary pass across 9 surfaces.** Plain-text and sparse cards rebuilt with structured embed layouts and a unified emoji vocabulary (📒 List · 🗡️ Raid · 🌐 Scope · 📝 Reason · 🧬 Tracked alts · 🔗 Logs · 👤 Added by · 🆔 Request ID · 🔍 Checked · 🎯 Found · ⚠️ Failed · 🔁 Attempts · 🌐 ScraperAPI):
  - **`/la-list enrich` Confirm success card** carries class + ilvl per alt, scan source (guild + hidden-roster indicator), and a Tip footer pointing at `/la-list view`. Mongoose `matched/modified` counts moved to a server-side debug log.
  - **Scan result embed** (enrich + roster deep) splits stats into 3-up inline fields (Checked / Found / Failed plus optional Remaining / Attempts / 429 retries / ScraperAPI) so the description carries narrative only.
  - **Scan completion DM** aligned with the result card: same emoji vocab, same hero line opening with command + channel mention.
  - **`/la-list view` page** adds a third line per entry showing the first three tracked alts and a `+N more` suffix.
  - **Detail evidence embed** (`/la-list view` and `/la-search` evidence dropdowns share `buildEvidenceEmbed`) gains a `🧬 Tracked alts` field with up to 12 numbered linked names.
  - **Cross-server broadcast** gains the same `🧬 Tracked alts` field so recipients in other servers have alt context inline.
  - **`/la-list check`** moves from message content (2000-char cap) to a structured embed with state-driven icon, breakdown line, 3-up stats panel, and actionable footer.
  - **`/la-list remove`** confirm + success render as embeds with list icon, scope tag, and a tracked-alts preview. Failure paths (legacy entry, not-owner) get distinct copy in the same card.
  - **`/la-list add` approval DM** leads with the list icon (⛔/✅/⚠️) instead of the generic shield so approvers triage at a glance. Adds Tracked alts field, scope chip, and matches the v0.5.65 detail/broadcast vocab.
  - **`/la-status`** moves title to `setTitle` with a state dot prefix; adds stats badge fields and priority-sorted per-server grid so outages float to the top.
  - **`/la-list trust add/remove`** gains a hero description, emoji-prefixed fields, next-step Tip footer. Remove uses `COLORS.muted` instead of `COLORS.danger` because it's a neutral state change.
  - **`/la-list multiadd` approval DM** gets a per-type breakdown line, outcome-driven color tint, per-row raid tag, and structured fields matching the single-add approval DM.

### Notes
- 57/57 tests pass.
- Tier-2 audit list (multiadd preview, status, trust) closed; every user-facing surface flagged as plain-text or sparse is now structured.
- Helpers `isTransientInteractionError` + `logTransientInteraction` exposed for the button/select dispatcher catches if we see similar transient noise on those code paths.

## [v0.5.64] - 2026-05-04

### Changed
- `/la-roster deep:true` and `/la-list enrich` are now available to regular users. To avoid request storms, regular users can keep only one Stronghold scan active at a time across both commands.
- Officers and seniors are treated as privileged operators and can still run parallel Stronghold scans when needed.

## [v0.5.63] - 2026-05-04

### Changed
- Cross-server list broadcast cards no longer include the `/la-setup off to mute cross-server list broadcasts` footer hint.

## [v0.5.62] - 2026-05-04

### Fixed
- `/la-list add` hidden-roster success cards now check whether lostark.bible exposes a guild before offering enrich. If a guild is present, the card names `/la-list enrich name:<character>` and keeps the **Enrich now** button. If no guild is visible, the button is omitted and the card points officers to `/la-list edit ... additional_names` instead.

## [v0.5.61] - 2026-05-04

### Fixed
- Long-running stronghold scans now carry a concise abort reason into the final result card/DM. System stops such as repeated Discord progress-card update failures render as `Scan stopped: issue detected` with a short reason instead of only logging server-side.
- Progress cards now distinguish `Checked` from `Attempts`, so users can tell whether candidates were actually parsed or merely tried and failed.

## [v0.5.60] - 2026-05-04

### Fixed
- Stronghold deep scans now auto-pause when lostark.bible starts rejecting nearly every candidate profile. Instead of spending 30+ minutes producing `Failed 200+ / Found 0`, the detector stops after a high-failure sample and leaves failed candidates retryable for a later Continue pass.
- Continue-scan state now distinguishes successfully checked names from failed attempts. A failed candidate is no longer written into `scannedNames`, so retrying later does not skip profiles that were never actually parsed.

## [v0.5.59] - 2026-05-04

### Fixed
- Long-running scan reply edits now resolve the real Discord message after the first webhook edit and use `Message.edit()` for later progress/final updates. This covers `/la-list enrich` runs where `interaction.editReply()` returned a non-editable API message shape, causing the final result edit to still hit the expired interaction webhook after 15+ minutes.

## [v0.5.58] - 2026-05-04

### Added
- `/la-stats` now includes process-lifetime ScraperAPI usage: total requests, success/failure split, network errors, last-used time, and per-key counts. Long stronghold scan result/DM cards also show how many ScraperAPI requests that scan consumed when non-zero.

### Notes
- Counts are bot-side in-memory counters and reset on restart/redeploy. They are meant to catch accidental quota burn during LoaLogs scans, not replace ScraperAPI's account dashboard.

## [v0.5.57] - 2026-05-03

### Changed
- Cross-server list broadcast headlines no longer include the requester display name. Notifications now read like `Name was added to Blacklist` instead of `Name was added to Blacklist by Officer`, while internal audit fields remain stored for permission checks and owner review.

## [v0.5.56] - 2026-05-03

### Fixed
- Long-running `/la-list enrich` and `/la-roster deep:true` scans no longer fail with `DiscordAPIError[50027]: Invalid Webhook Token` after Discord's ~15-minute interaction webhook window expires. After the first progress card is created, scan flows now keep the Discord `Message` object and update it with `message.edit()` via the bot token for progress/final cards.
- Stronghold deep scans now react to lostark.bible `429` responses even when the retry eventually succeeds. Candidate pacing ramps up to an 8s gentle-mode ceiling after rate-limit retries, and per-candidate retry warnings are suppressed in gentle scans so logs no longer fill with red `HTTP 429 ... waiting ...` lines. Progress/result cards surface a compact `429 retries` count instead.

### Notes
- This specifically covers scan runs that exceed the original interaction token lifetime, such as large guild scans still in progress around 30+ minutes.

## [v0.5.55] - 2026-05-03

### Fixed
- `/la-search` evidence dropdown picked the wrong entry when a result was on multiple lists but only some carried an image. Old logic `r.black || r.white || r.watch` returned the first truthy entry regardless of whether it had evidence; clicking the dropdown then surfaced "No evidence" even though the option existed. Both dropdown construction and the on-click handler now pick the entry with the image (priority black → white → watch). Embed label/color/title-emoji follow the picked entry too.
- `/la-help lang:en` in the owner server exceeded Discord's 2000-char message-content cap (~2106 chars EN, ~1964 VN). Discord rejected the reply silently. Help text now ships as an embed description (4096-char ceiling) instead of message content; smoke-test shows EN owner at 2270 chars, well under the new limit.
- Help text for `/la-roster` was missing the `[deep_limit]` option (added in v0.5.x); `/la-list edit` was missing the `[additional_names]` option. Help, README, and smoke test now all list both.

### Notes
- 42/42 tests pass.
- Synced README's `/la-list edit` row with the new option per `feedback_sync_help_docs` rule.

## [v0.5.54] - 2026-05-03

### Added
- **Continue scan** button on `/la-list enrich` and `/la-roster deep:true` result cards. When a scan stops early (Stop button) or hits the candidate cap, the result card now offers Continue alongside Save/Discard. Continue resumes the same scan with prior `scannedNames` fed back as `excludeNames`, so the next pass walks only fresh candidates without re-fetching already-visited profiles.
- **Hidden roster notice** block on the unified result card. When the target's roster is hidden on bible, the embed renders a `🔒` notice explaining stronghold-fingerprint detection mechanics (matches by SH name + roster level, only sees alts in the same guild). Detected once at the start of an enrich pass via `buildRosterCharacters({ hiddenRosterFallback: true })`, then cached on the session so Continue passes don't re-probe.
- `bot/utils/scanResultEmbed.js` (new): unified post-scan embed + button matrix for both commands. State machine derives `completed` / `stopped` / `cap-hit` from the result envelope; button row picks Confirm / Continue / Save partial / Discard based on (kind, hasAlts, hasRemaining).
- `bot/utils/rosterDeepSession.js` (new): 5-min TTL session store for `/la-roster` Continue. Caches `meta` + `guildMembers` + `primaryEmbedJSON` so a resume click doesn't re-scrape the visible roster page or the blacklist/whitelist match.

### Changed
- `detectAltsViaStronghold` accepts a new `excludeNames: string[]` option that filters base candidates BEFORE applying `candidateLimit`. Result envelope adds `scannedNames`, `totalEligibleInGuild`, and `excludedCandidates` so a cumulative remaining-count stays correct across multiple resume passes.
- Enrich post-scan flow consolidated: four branch-specific embed builds (completed-with-alts, completed-no-alts, stopped-with-alts, stopped-no-alts) collapse into a single `buildScanResultEmbed` call. Session lifecycle moves earlier so Continue button has access regardless of new-alt count.
- `/la-roster deep:true` result moves the alt list off the main roster card into a dedicated second embed. Visible-roster callers see `[main roster card] [scan result card]` stacked; hidden-roster callers see `[hidden roster + list hits] [scan result card]`.

### Notes
- 42/42 tests pass.
- Continue across multiple passes accumulates `allDiscoveredAlts` and `scannedNames` on the session; Confirm at any point saves whatever is currently in `newAlts` (cumulative diff vs `entry.allCharacters`).
- `buildEnrichPreviewReply` removed from `enrich/ui.js` since `buildScanResultEmbed` now handles all post-scan paths.

## [v0.5.53] - 2026-05-03

### Added
- Live progress embed for `/la-list enrich` and `/la-roster deep:true` now lists the **alt names found so far** instead of just a count. Each match shows `• <Name> · <Class> · <ilvl>` so the officer can confirm the scan is finding real targets in real time. Cap of 12 visible names with `... and N more` overflow line keeps the description well under Discord's 4096-char limit.
- `detectAltsViaStronghold` `onProgress` payload now includes a shallow-copied `alts` array. The detector emits per 5 candidates so name list updates within 7-8 seconds of a new match (vs every 25 candidates / 37+s before).

### Changed
- Progress embed footer label shifted from "30s update interval" to "15s update interval" to match the throttle change shipped in `d811c18`.

### Notes
- 42/42 tests pass.

## [v0.5.52] - 2026-05-03

### Added
- **Stop button** on every long-running stronghold scan (`/la-list enrich`, `/la-roster deep:true` hidden + visible). Officers can interrupt a scan that's clearly stuck (e.g. bible blanket-rejecting requests) without waiting for the 15-min Discord webhook timeout. Click feedback is immediate ephemeral ack ("Stop signal sent · worker exits at end of current candidate"); the embed flips its button to disabled "Stopping..." on the next progress tick. Final post-scan card on cancel reads `🛑 Scan stopped · Ainslinn` with scanned/failed counts and a hint to retry off-peak.
- `bot/utils/scanSession.js` (new): module-level Map keyed by short sessionId tracks active scans. `registerScan` / `unregisterScan` lifecycle is wrapped in `try/finally` so a thrown scan still releases its slot. `buildStopButtonRow(sessionId, opts)` ships the standard Stop-scan button row used by both progress embeds.

### Changed
- Scan worker now emits `onProgress` every **5 candidates** instead of every 25, so the embed has fresher progress data between throttled UI edits. Console log stays at per-25 (operator-facing).
- Progress UI throttle tightened **30s → 15s** in both enrich and roster handlers. Math: 15s × ~60 ticks over a 15-min scan = well under Discord's 5 edits/5s rate-limit ceiling. Users reported the 30s gap felt frozen between updates.
- `detectAltsViaStronghold` accepts a shared `cancelFlag = { cancelled: false }` option; the scan worker checks it at the top of each candidate iteration and exits early. Result includes `cancelled: true/false` so callers can render a distinct "stopped" embed.
- Hidden-roster + visible-roster paths in `rosterHandler.js` both wire the cancelFlag through `detectAltsViaStronghold` and present the Stop button identical to enrich.

### Notes
- Cancellation auth: the user who started the scan can always stop it; any officer/senior can stop any scan.
- Worker may still complete its in-flight `fetchCharacterMeta` (a few seconds) before exiting because we don't pass an AbortSignal yet · acceptable trade-off vs the complexity of wiring abort through the rate-limit retry layer.
- 42/42 tests pass.

## [v0.5.51] - 2026-05-03

### Changed
- Wave 2 polish batch · prettier visual hierarchy across four more result embeds:
  - **`/la-search` results card**: title now `🔍 Search · "<query>"`. New top-of-description summary breaks down list-status counts (`⛔ 3 · ⚠️ 2 · ✅ 1 · ❓ 5 clean`) so officers see triage at a glance before scanning the result list. Footer reorganised: filters first, source-of-truth second.
  - **`/la-list * broadcast` cross-server card**: title becomes `📩 List <action> broadcast`; description leads with a single headline `⛔ [Name] was added to Blacklist by Officer.` so recipients absorb the change in one read instead of parsing fields. Reason promoted to full-width field; raid + relative-time stay inline. Footer cites `/la-setup off` as the mute path.
  - **`/la-list multiadd` template + preview embeds**: footer text uses middot separators, preview uses `buildSessionFooter(5, 'only the uploader can confirm')` for consistency with the enrich preview. `buildNoValidRowsEmbed` migrated to `buildAlertEmbed` for severity color match. Preview description gets a one-line headline instead of footnote-only error count.
  - **Bulk add summary embed**: description headline shows success rate `12 of 15 added (80%)`. Footer cites submitter explicitly with "Submitted by X".

### Notes
- 42/42 tests pass. No handler signatures changed; pure UI polish.
- ACTION_VERB lookup table in broadcasts replaces the inline `actionCap` string so `added/edited/removed` map to grammatically clean prepositions in the headline ("added to" / "edited in" / "removed from").

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
