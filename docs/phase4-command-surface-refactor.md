# Phase 4 — Command Surface Refactor (Design Document)

> **Status:** Pending review. NOT executed.
> **Drafted:** 2026-05-03 by Senko, based on Traine's flag "list list nhiều quá".
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

### Direction B — Entity-based top-level (Senko's recommendation)

Each list type gets its own command tree with the verbs nested under it.

```
/blacklist add name:... reason:...
/blacklist edit name:...
/blacklist remove name:...
/blacklist view [scope:...]
/blacklist enrich name:...
/blacklist bulk action:<template|file>

/whitelist add name:... reason:...
/whitelist edit name:...
/whitelist remove name:...
/whitelist view

/watchlist add name:... reason:...
/watchlist edit name:...
/watchlist remove name:...
/watchlist view

/trust add name:... reason:...   (separate, not under any list)
/trust remove name:...
/trust view

/check image:...                 (OCR cross-list, replaces /listcheck)
```

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

## 3. Recommendation: Direction B (entity-based)

Senko's call. Reasoning:

1. **It directly addresses the "list list nhiều quá" complaint** by making the entity the primary identifier instead of the verb. Users no longer scan 7 subcommands to find the one they want.
2. **It matches the underlying data model.** Each list is already a separate Mongoose model with its own collection and its own scope rules (only blacklist supports `server` scope). Surfacing this in the command tree makes the model visible to users instead of hidden behind a `type:` option.
3. **It is the only direction that lets `/blacklist` and `/whitelist` diverge cleanly.** Today they share `/list add` but blacklist has scope/image/approval flow that whitelist does not. After the split, each entity command can carry exactly the options it needs.
4. **Migration is one-shot, but well-scoped.** Users learn three new prefixes (`/blacklist`, `/whitelist`, `/watchlist`) plus `/trust` and `/check`. After the rollout window, the mental model is permanent.

Direction A (verb-based) was tempting for typing brevity, but Senko vetoed it because top-level generic verbs (`/add`, `/edit`, `/view`) are too easy to collide with future commands and the result reads less self-describing.

Direction C (mode-flag merge) is the smallest change but leaves the deeper structural problem alone.

---

## 4. Migration strategy (if Direction B is approved)

1. **Phase 4a — implement new commands behind a flag.** Add the new `/blacklist`, `/whitelist`, `/watchlist`, `/trust`, `/check` command tree alongside the existing `/list *` and `/listcheck`. Both surfaces work, share handlers via a thin adapter that translates the new args into the existing handler signatures. No DB schema change.
2. **Phase 4b — soft deprecate.** Add a one-line deprecation notice on every `/list <subcommand>` reply: "*Note: `/list add` will be replaced by `/blacklist add` on YYYY-MM-DD. The new commands are live now — try them out.*" Help text shows both surfaces with the new one starred.
3. **Phase 4c — hard deprecate.** Remove `/list *` and `/listcheck` from the slash command registration. Discord drops them on next deploy. Help text shows only the new surface. Welcome embed updated.
4. **Phase 4d — cleanup.** Delete the adapter layer; handlers are called directly from the new dispatch.

Each phase is its own commit. Phases 4a and 4b can ship in the same release; 4c is the breaking change and gets its own commit with a clear CHANGELOG entry. Phase 4d is bookkeeping.

Suggested deprecation window: **2 weeks** between 4b ship and 4c ship. Long enough for daily users to see the deprecation notice at least once.

---

## 5. Open questions for Traine

These are the decisions Senko cannot make alone. Phase 4 execution is blocked on them.

1. **Pick a direction (A / B / C).** Senko recommends B but the call is yours.
2. **Should `/list trust` move to a new top-level `/trust`, or stay nested under one of the new commands?** Senko proposes top-level `/trust` because it is conceptually orthogonal. But if users always think of it as "the fourth list," nesting it (e.g. `/trust add`) is fine.
3. **Rename `/listcheck` to `/check`?** Both are short. `/check` is more general. Possible collision with future "check server status" command — but `/status` already covers that.
4. **Soft-deprecation window length** (1 week / 2 weeks / 1 month). Longer = friendlier to users, shorter = less time maintaining two surfaces.
5. **Should `bulk` (current `/list multiadd`) live under `/blacklist` only, or under each list type?** Senko's read: blacklist is the only list that benefits from xlsx bulk import (whitelist and watchlist are typically small + curated). Default to blacklist-only.
6. **Welcome / pinned embed updates** are part of the rollout — does the bot have an existing welcome embed flow we need to update too? (Senko did not see one in the LoaLogs side; only `/lasetup` for channel config.)

---

## 6. What this document is NOT

- Not an audit of usage data. Senko did not pull command-usage logs (no telemetry surfaced in the codebase). If usage data exists somewhere, it would refine the cap on bulk vs single, the priority of preserving old aliases, and the deprecation window. Recommend pulling that before 4a.
- Not a code change. Zero commits to the runtime surface here.
- Not a migration script for stored data. The DB schema does not change with any of these directions; only the command surface does.

---

*End of document. Phase 4 execution waits on Traine's answers above.*
