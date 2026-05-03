# Phase 4 — Command Surface Refactor (Design Document)

> **Status:** Direction D approved (la- prefix universal rename, keep /list namespace). NOT executed.
> **Drafted:** 2026-05-03 by Senko, based on Traine's flag "list list nhiều quá".
> **Updated 2026-05-03 (am):** Traine added the `la-` prefix directive — every bot command must carry it so Discord autocomplete groups them under `/la`.
> **Updated 2026-05-03 (pm):** Direction B (entity split) **rejected** by Traine — users are already used to the `/list ...` prefix and splitting blacklist/whitelist/watchlist into top-level entity commands would break that habit. Pivoted to Direction D: keep the `/list` subcommand tree structurally identical, just rename to `/la-list` and rename every other top-level command to add `la-`.
> **Predecessor work:** Item 2 Phases 1-3 shipped 2026-05-03 (commits `2908724`, `e5220db`, `30b64d7`, `9722c20`).

This document is the writing-plan for Phase 4. It does not change code. Once Traine picks a direction and answers the open questions at the bottom, a follow-up session executes the refactor.

---

## 1. Current command surface (audit)

### Top-level commands

| Command | Subcommands | Owner | Notes |
|---------|-------------|-------|-------|
| `/status` | — | anyone | Live LA server status |
| `/reset` | — | anyone | Reset stored status state |
| `/roster <name> [deep] [deep_limit]` | — | anyone | Roster fetch + optional alt-detect |
| `/search <name> [filters]` | — | anyone | Name search with class/ilvl filter |
| `/listcheck <image>` | — | anyone | OCR screenshot, cross-check lists |
| `/list` | 7 subcommands (see below) | mixed | The crowded namespace |
| `/lahelp [lang]` | — | anyone | Help text |
| `/lasetup` | autochannel, notifychannel, view, off, defaultscope | admin | Per-guild config |
| `/lastats` | — | admin | Stats dashboard |
| `/laremote` | action, guild, scope, channel | owner | Cross-guild remote management |

### `/list` subcommand tree (the focus)

| Subcommand | Permission | Purpose | Typical user |
|------------|-----------|---------|--------------|
| `/list add` | anyone (with approval flow for non-officers) | Single-character add to blacklist/whitelist/watchlist | Member reporting griefer |
| `/list multiadd` | officer (auto) / member (approval) | Bulk add via xlsx template (max 30 rows) | Officer importing roster |
| `/list edit` | varies | Edit an existing entry's reason/raid/type/scope/image | Officer correcting mistake |
| `/list remove` | varies | Remove entry from any list | Officer cleanup |
| `/list view` | anyone | Paginated browse of a list | Member checking who's blacklisted |
| `/list trust` | officer | Manage "trusted" exception list | Officer marking known-safe alts |
| `/list enrich` | officer (just shipped Phase 3) | Stronghold deep-scan an entry, append discovered alts | Officer expanding ban coverage |

### Pain points Senko observed reading the code

1. **Cognitive load on /list**: 7 subcommands, three of them are "add variants" (`add`, `multiadd`, `enrich` — all add data to entries). Hard to discover which to use when.
2. **`/listcheck` lives outside `/list`**: it's a "check" verb conceptually, but lives at the top level alongside `/list view` (also a check verb in spirit). Inconsistent grouping.
3. **`/list trust` is a list-of-lists meta-concept**: it manages who is exempted from the other lists. Sitting inside `/list` makes it look like a peer of blacklist/whitelist/watchlist when it's actually orthogonal.
4. **`/list add type:black|white|watch`**: type is a required option, but blacklist behavior diverges most (scope option, evidence image, approval flow). The shared option set hides type-specific behavior.
5. **No verb-first discoverability**: a member who wants to "add to blacklist" types `/list` then has to scan 7 subcommands. The first instinct of `/blacklist add` would be more direct.

---

## 2. Three refactor directions

Each direction is described with concrete final command names, pros/cons, and migration cost. They are mutually exclusive — Phase 4 picks one.

### Direction A — Verb-based top-level

Promote each verb out of the `/list` namespace to a top-level command. Type/list becomes an option.

```
/add type:<black|white|watch> name:... reason:...
/edit name:...
/remove name:...
/view type:...
/check image:...                 (replaces /listcheck)
/enrich name:...
/bulk action:<template|file>     (replaces /list multiadd)
/trust action:<add|remove> name:...
```

**Pros:**
- Shortest typing per command.
- Each verb lands at the top of Discord autocomplete, so `/a` shows `/add` immediately.
- Eliminates the `/list` namespace entirely — answers "list list nhiều quá" by removing the prefix.

**Cons:**
- Polluting the top-level namespace with 8 generic verbs collides with future LA-specific commands (`/edit` is too generic — what does it edit?). Discord global verb names get crowded fast.
- Less self-describing: `/add` gives no hint it is a list operation. New users won't intuit `/add` is for blacklist.
- Migration breaks every existing user habit at once.

**Migration cost:** Highest — every command renamed, help/welcome/docs all rewritten, users have to relearn the entire surface.

### Direction B — Entity-based top-level (REJECTED 2026-05-03 pm)

Rejected because users are already familiar with the `/list ...` prefix and splitting it into per-entity top-level commands (`/la-blacklist`, `/la-whitelist`, `/la-watchlist`) breaks that habit. The cognitive-load benefit is real but does not outweigh the disruption of established workflows. Direction kept in this document for historical context.

### Direction B (rejected) — original proposal

Each list type gets its own command tree with the verbs nested under it. **All commands carry the `la-` prefix** (Traine's directive 2026-05-03) so Discord autocomplete groups every bot command under `/la`. This unifies the existing `/lahelp` / `/lasetup` / `/lastats` / `/laremote` surface with the new entity commands and folds in the legacy non-prefixed commands (`/status`, `/reset`, `/roster`, `/search`, `/listcheck`, `/list *`).

**New entity-based command tree:**

```
/la-blacklist add name:... reason:...
/la-blacklist edit name:...
/la-blacklist remove name:...
/la-blacklist view [scope:...]
/la-blacklist enrich name:...
/la-blacklist bulk action:<template|file>

/la-whitelist add name:... reason:...
/la-whitelist edit name:...
/la-whitelist remove name:...
/la-whitelist view

/la-watchlist add name:... reason:...
/la-watchlist edit name:...
/la-watchlist remove name:...
/la-watchlist view

/la-trust add name:... reason:...    (separate, not under any list)
/la-trust remove name:...
/la-trust view

/la-check image:...                  (OCR cross-list, replaces /listcheck)
```

**Renames of existing non-list commands** (to fit the unified `la-` prefix):

| Old | New |
|-----|-----|
| `/status` | `/la-status` |
| `/reset` | `/la-reset` |
| `/roster` | `/la-roster` |
| `/search` | `/la-search` |
| `/listcheck` | `/la-check` (also moves into the entity-aware namespace conceptually) |
| `/lahelp` | `/la-help` |
| `/lasetup` | `/la-setup` |
| `/lastats` | `/la-stats` |
| `/laremote` | `/la-remote` |

**Final surface count (under rejected Direction B):** 13 top-level commands, all `la-` prefixed. Discord autocomplete on `/la` surfaces every one of them in a single grouped list. Rejected — see top of section for reasoning.

### Direction D — Universal `la-` prefix, keep `/list` namespace (APPROVED)

Smallest behavioral change while still hitting the autocomplete-grouping goal. Every top-level command is renamed to add the `la-` prefix; the `/list` subcommand tree keeps its structure exactly as it is today.

**New surface:**

```
/la-list add type:<black|white|watch> name:... reason:...
/la-list edit name:...
/la-list remove name:...
/la-list view type:...
/la-list trust action:<add|remove> name:...
/la-list enrich name:...
/la-list multiadd action:<template|file>

/la-status
/la-reset
/la-roster <name> [deep] [deep_limit]
/la-search <name> [filters]
/la-check image:...                  (renamed from /listcheck)
/la-help [lang]                      (renamed from /lahelp)
/la-setup ...                        (renamed from /lasetup)
/la-stats                            (renamed from /lastats)
/la-remote ...                       (renamed from /laremote)
```

**Rationale:**
- Preserves established `/list <verb>` muscle memory for daily users — they only learn the `la-` prefix, the verbs and option layouts stay identical.
- Adds the autocomplete-grouping benefit Traine wanted: typing `/la` in Discord surfaces every bot command as a grouped suggestion list.
- Touches every command file but in a uniform mechanical way (rename + register both old and new aliases during the soft-deprecation window).
- Open: do we ALSO merge `add` + `multiadd` into `/la-list add mode:<single|bulk>` while we are renaming? See open question 5 below.

**Final surface count under Direction D:** 10 top-level commands (one `/la-list` parent with 7 subcommands + 9 other top-level commands), every name `la-` prefixed.

**Pros:**
- Maps onto how users think: "I want to blacklist this guy" -> `/blacklist add`. Type is primary, verb is secondary.
- Self-describing: every command name tells you the entity. No ambiguity about what `/blacklist edit` edits.
- Each entity is independently discoverable in Discord autocomplete.
- Matches the data model: each list is its own Mongoose model, now each has its own command surface.
- Bulk add (`bulk`) and enrich move into `/blacklist` where they actually live (whitelist/watchlist rarely need bulk import or alt-detect enrichment).
- Trust stays separate because it is conceptually orthogonal (an exception layer, not a list).

**Cons:**
- More command-level surface (4 entities + check = 5 top-level vs 3 today). Manageable.
- Slightly more typing than verb-based for the most common case (`/blacklist add` vs `/add`).
- Some duplication of subcommand definitions across the three list types (mitigated by builder helpers).

**Migration cost:** Medium-high. Users learn one new prefix per list type. Help/welcome rewrites.

### Direction C — Mode-flag merge inside `/list`

Keep the `/list` prefix; merge the add variants into one subcommand with a mode flag.

```
/list add mode:<single|bulk|enrich> name:... [reason:...] [file:...]
/list edit
/list remove
/list view
/list trust
/list check                      (move /listcheck inside)
```

**Pros:**
- Keeps user habit: existing `/list <verb>` prefix stays.
- Reduces 7 -> 5 subcommands (modest win).
- One less top-level command (`/listcheck` folds in).

**Cons:**
- `/list add mode:enrich` is awkward — enrich is not really an add, it appends to an existing entry.
- Doesn't address the deeper issue (one prefix for many concepts). Just compresses the symptom.
- `mode` flag's optional fields differ wildly (single needs reason+image, bulk needs file, enrich needs deep_limit). Slash command UX with conditional required-options is bad.

**Migration cost:** Low. Existing users can keep most habits; just learn the mode flag.

---

## 3. Decision: Direction D — universal `la-` prefix, keep `/list` namespace (approved)

**Approved by Traine 2026-05-03 pm.** Decision path:

1. Original draft recommended Direction B (entity-based split into `/la-blacklist`, `/la-whitelist`, `/la-watchlist`). Rejected because users are already used to the `/list ...` prefix and splitting it breaks established habit.
2. Pivot to Direction D: keep the `/list` subcommand tree intact, just rename to `/la-list` and rename every other top-level command to add `la-`.

**Why this is the right call:**

1. **Preserves user habit.** Daily users keep typing `/list add`, `/list view`, `/list edit` exactly as before — only the prefix changes. Cognitive load of relearning is the smallest of the three remaining options.
2. **Hits the autocomplete-grouping goal.** Typing `/la` in Discord surfaces every bot command as one grouped suggestion list. That was the explicit Traine directive and the main UX win.
3. **Mechanical execution.** Every command file is touched but in a uniform rename pattern. Low risk of behavior change during the rename pass.
4. **Soft-deprecation friendly.** During the rollout window, both old and new names can be registered as aliases pointing at the same handler. Users see both in autocomplete with the new one preferred; old name redirects with a deprecation banner.

Direction A (verb-based, no prefix) — rejected: too generic, prone to collision with other bots' commands.
Direction B (entity split) — rejected: breaks user habit (Traine 2026-05-03 pm).
Direction C (mode-flag merge inside `/list`) — partial overlap with D. The merge piece (`add` + `multiadd` -> `add mode:single|bulk`) is now an open sub-question (#5) rather than a separate direction; if Traine wants it, we fold it into the Direction D rename pass.

---

## 4. Migration strategy (Direction D)

1. **Phase 4a — register both old and new names.** Each command (top-level and the `/list` subcommand parent) is registered twice in `commands.js` with the same handler: the old name (`status`, `roster`, `list`, `lahelp`, etc.) plus the new name (`la-status`, `la-roster`, `la-list`, `la-help`, etc.). Both work. No internal logic change. Help text starts showing only the new names.
2. **Phase 4b — soft deprecate.** Every reply from an old-name invocation prepends a one-line banner: "*Note: `/list add` is now `/la-list add`. The old name will stop working on YYYY-MM-DD. Try `/la-list add`.*" Help/welcome embed list only the new names.
3. **Phase 4c — hard deprecate.** Remove the old aliases from `commands.js`. Discord drops them on next deploy. Help text shows only the new surface; welcome embed updated.
4. **Phase 4d — cleanup.** Remove any leftover banner code introduced in 4b.

Each phase is its own commit. 4a and 4b can ship in the same release; 4c is the breaking change and gets its own commit with a clear CHANGELOG entry. 4d is bookkeeping.

Suggested deprecation window: **2 weeks** between 4b ship and 4c ship. Long enough for daily users to see the deprecation banner at least once on every command they use regularly.

**Optional add-on (open question 5):** if Traine wants `/list add` and `/list multiadd` merged into `/la-list add mode:<single|bulk>`, that change folds into Phase 4a — same rename pass, plus the merge logic in the add handler. Recommend deciding before 4a starts so we don't ship a rename and then a structural change back-to-back.

---

## 5. Open questions for Traine

Direction D is approved. These remaining decisions still need answers before Phase 4a code execution.

1. ~~Pick a direction (A / B / C).~~ **Answered: Direction D.**
2. **Soft-deprecation window length** (1 week / 2 weeks / 1 month). Longer = friendlier to users, shorter = less time maintaining two surfaces. Senko default: 2 weeks.
3. **Should `/list multiadd` merge into `/la-list add mode:<single|bulk>` during the rename?** Pros: cleaner subcommand tree (6 instead of 7), aligns with how users think (one "add" entry point). Cons: changes both name AND structure in the same pass — slightly more user disruption. Senko leans **no merge** to keep Phase 4 pure rename, leave merge as a separate later proposal if still wanted.
4. **Should `/listcheck` rename to `/la-check` or `/la-listcheck`?** `/la-check` is shorter; `/la-listcheck` preserves the "list-related verb" association. Senko leans `/la-check` since the OCR cross-list lookup is the "check" verb conceptually.
5. **Should we ALSO standardize the existing `/lahelp` / `/lasetup` / `/lastats` / `/laremote` to the dashed form `/la-help` etc.?** Required for consistency under Direction D. The cost is breaking those existing four commands too; they currently work without a dash. Senko recommends **yes, standardize** so the entire `la-` family is uniform.
6. **Welcome / pinned embed updates** — does LoaLogs have an existing welcome embed flow we need to refresh, or only the help text? Senko did not see one; only `/lasetup` for channel config. If a welcome surface exists, point Senko at it for Phase 4b.

---

## 6. What this document is NOT

- Not an audit of usage data. Senko did not pull command-usage logs (no telemetry surfaced in the codebase). If usage data exists somewhere, it would refine the cap on bulk vs single, the priority of preserving old aliases, and the deprecation window. Recommend pulling that before 4a.
- Not a code change. Zero commits to the runtime surface here.
- Not a migration script for stored data. The DB schema does not change with any of these directions; only the command surface does.

---

*End of document. Phase 4 execution waits on Traine's answers above.*
