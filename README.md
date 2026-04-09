# 🎮 Lost Ark Discord Bot

A Discord bot that monitors Lost Ark server status, supports roster lookup, manages guild blacklist/whitelist/watchlist entries, and detects alt characters via Stronghold fingerprinting.

## Main Features

### 🖥️ Server Monitoring
- **Multi-server monitoring**: Monitors one or more servers (e.g. Brelshaza, Thaemine) with a single page fetch.
- **Auto-notification**: Sends `@here` when servers transition from offline/maintenance to online.
- **`/status`**: Live server status check on demand.

### 🔍 Roster & Character Lookup
- **`/roster`**: Fetch roster from lostark.bible with progression tracking (shows ilvl delta since last check).
- **`/search`**: Find similar character names with filters (ilvl range, class) and cross-check against all lists.
- **Alt detection**: When roster is hidden, detects alt characters via Stronghold name + Roster Level matching across guild members.
- **Guild member check**: When roster is hidden, checks all guild members against all lists.
- **OCR similar suggestions**: When Gemini misreads diacritics, shows similar names with list flags (e.g. `⛔ Lùnaria, ❓ Lunaria`).
- **Roster match origin**: When flagged via roster alt, shows which character caused the flag (e.g. "via MainChar — reason").

### 📋 List Management
- **Blacklist / Whitelist / Watchlist**: Three list types with `⛔`, `✅`, `⚠️` icons.
- **Server vs Global blacklist**: Blacklist entries can be `global` (shared) or `server` (per-guild only). Owner server sees all entries; others see global + own.
- **Trusted user list**: Trusted characters (and their alts) cannot be added to any list. Officer/senior managed.
- **`/list add`**: Add entries with approval flow (officers auto-approve, server-scoped auto-approve), optional raid tag, logs URL, evidence image, and scope (global/server). Validates ilvl >= 1700.
- **`/list edit`**: Edit existing entries (owner/officer instant, others via approval).
- **`/list remove`**: Remove entries with ownership check.
- **`/list view`**: View entries with scope filter. Clickable 📎 evidence links. Owner server can filter by scope.
- **`/list trust action:add/remove`**: Manage trusted user list (officer/senior only).
- **Cross-server broadcast**: Global entries broadcast to all configured channels; server-scoped entries broadcast to owner guild only (with `(Local)` tag).
- **🛡️ Trusted indicators**: Trusted users shown with 🛡️ in auto-check, `/listcheck`, `/search`, `/roster` results. Alt detection via roster allCharacters ("via **TrustedName**").
- **Auto-enrich**: When a flagged character is found, background guild scan discovers and links alt characters to `allCharacters`.

### 📸 Screenshot Checking
- **`/listcheck`**: Extract up to 8 names from a screenshot via Gemini OCR, check against all lists.
- **Auto-check channels**: Drop screenshots in configured channel(s) for automatic checking (🔍 → ✅).
- **Quick Add**: After auto-check, dropdown to quickly add unflagged names to blacklist/watchlist via Modal popup.
- **Server name filter**: Prevents OCR from extracting server names (Vairgrys, Brelshaza, etc.) as player names.
- **Gemini model failover**: Automatically switches to next model on quota/rate limits or timeout.

### ⚙️ Technical
- **Guild-only commands**: All slash commands have `setDMPermission(false)` — not available in DMs.
- **Direct fetch with ScraperAPI fallback**: Fast direct access to lostark.bible, auto-fallback via proxy on 403/503. Smart cache skips wasted direct fetches when blocked.
- **Roster-based duplicate checks**: `allCharacters` field with case-insensitive matching and MongoDB index.
- **RosterCache**: Caches roster check results in MongoDB (TTL 24h) — same character across multiple screenshots skips HTTP requests.
- **Batch DB queries**: List check and search use `$in` batch queries (~4-7 queries instead of ~35-60).
- **Scope priority**: `server > global` applied consistently — when both scopes exist for same name, server entry takes precedence.
- **GuildConfig cache**: 60s in-memory cache reduces DB round-trips for scope/channel resolution. Invalidated on `/lasetup` changes.
- **Duplicate overwrite flow**: Update-in-place (no delete-then-add risk). Officers see `[Global]`/`[Server]` scope labels in comparison embed.
- **Spam protection**: 10s per-user cooldown on auto-check channels.

## Commands

| Command | Description |
|---|---|
| `/status` | Show live server status for all monitored servers |
| `/reset` | Reset the stored status state |
| `/roster name [deep]` | Fetch roster, progression delta, cross-check lists. `deep:true` runs Stronghold alt scan |
| `/search name [min_ilvl] [max_ilvl] [class]` | Search similar names (default ilvl ≥ 1700), cross-check all lists |
| `/list add type name reason [raid] [logs] [image] [scope]` | Add to blacklist/whitelist/watchlist. `scope`: global/server (blacklist only) |
| `/list edit name [reason] [type] [raid] [logs] [image]` | Edit existing entry (owner/officer: instant, others: approval) |
| `/list remove name` | Remove an entry (ownership check) |
| `/list view type [scope]` | View entries. `scope`: all/global/server (blacklist filter, owner sees all) |
| `/list trust action name [reason]` | Manage trusted list — add/remove (officer/senior only) |
| `/listcheck image` | OCR screenshot → check names against all lists |
| `/lastats` | Show bot usage statistics — owner server only |
| `/lahelp` | Show all available commands |
| `/lasetup autochannel #channel` | Set auto-check channel for this server (Manage Server) |
| `/lasetup notifychannel #channel` | Set notification channel for this server (Manage Server) |
| `/lasetup view` | View current channel configuration |
| `/lasetup off` | Toggle global list notifications on/off for this server |
| `/lasetup defaultscope global/server` | Set default blacklist scope for `/list add` (default: global) |
| `/laremote action [guild] [scope]` | Senior: remote config dashboard — owner server only |

### Status Icons

| Icon | Meaning |
|---|---|
| ⛔ | Blacklisted |
| ✅ | Whitelisted |
| ⚠️ | Watchlist (under investigation) |
| ❓ | Not in any list, roster exists |
| 🛡️ | Trusted user (cannot be blacklisted) |
| `[S]` | Server-scoped blacklist entry |
| `[S:Name]` | Server-scoped entry with server name (owner view) |

## Requirements

- Node.js >= 20
- MongoDB
- Discord bot token and channel ID
- Gemini API key (optional, needed for `/listcheck` and auto-check)
- Discord Privileged Intent: **Message Content Intent** (needed for auto-check channel feature)

## Environment Setup

Copy `.env.example` to `.env` and fill in values:

### Required

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `CHANNEL_ID` | Channel ID for server online notifications |
| `MONGODB_URI` | MongoDB connection string |

### Optional

| Variable | Description | Default |
|---|---|---|
| `CHECK_INTERVAL` | Status check interval in seconds (min: 10) | `30` |
| `TARGET_SERVERS` | Comma-separated server names to monitor | `Brelshaza` |
| `GEMINI_API_KEY` | Gemini API key for image OCR | — |
| `GEMINI_MODELS` | Comma-separated model priority list for failover | `gemini-2.5-flash,...` |
| `AUTO_CHECK_CHANNEL_IDS` | Channel IDs for auto-check — global fallback (use `/lasetup` per server) | — |
| `LIST_NOTIFY_CHANNEL_IDS` | Channel IDs for list notifications — global fallback (use `/lasetup` per server) | — |
| `OFFICER_APPROVER_IDS` | Officer Discord user IDs for /list add auto-approve | — |
| `SENIOR_APPROVER_IDS` | Senior approver Discord user IDs (always receive approval DMs) | — |
| `MEMBER_APPROVER_IDS` | Member approver Discord user IDs | — |
| `OWNER_GUILD_ID` | Owner/admin Discord server ID — can view all server-scoped blacklist entries | — |
| `SCRAPERAPI_KEY` | Fallback proxy when lostark.bible blocks direct access (403/503) | — |

## Run Locally

```bash
npm install
npm start
```

Dev mode (auto-restart on changes):

```bash
npm run dev
```

## Run with Docker

```bash
docker build -t lostark-discord-bot .
docker run --env-file .env --name lostark-bot lostark-discord-bot
```

## Deploy on Railway

1. Repository includes `Dockerfile` and `railway.toml`.
2. Set environment variables in the Railway **Variables** tab (do not upload `.env`).
3. Start command: `node bot.js`.
4. Enable **Message Content Intent** in Discord Developer Portal if using auto-check.

## Project Structure

```text
.
├── bot.js                          # Entry point: Discord client, command routing
├── config.js                       # Environment variable loading and validation
├── db.js                           # MongoDB connection (lazy singleton)
├── monitor.js                      # Server status polling loop + notifications
├── serverStatus.js                 # Scrapes playlostark.com for server status
│
├── bot/
│   ├── commands.js                 # Slash command definitions
│   ├── handlers/
│   │   ├── systemHandlers.js       # /status, /reset
│   │   ├── rosterHandler.js        # /roster (+ alt detection, progression)
│   │   ├── listHandlers.js         # /list add, /list remove, /list view, /listcheck
│   │   ├── searchHandler.js        # /search
│   │   ├── autoCheckHandler.js     # Auto-check channel listener
│   │   ├── setupHandler.js        # /lasetup (per-guild channel config)
│   │   └── statsHandler.js       # /lastats (bot usage statistics)
│   ├── services/
│   │   ├── rosterService.js        # lostark.bible scraping, alt detection, list checks
│   │   └── listCheckService.js     # Shared OCR + name checking + formatting
│   └── utils/
│       ├── names.js                # Character name normalization
│       └── scope.js                # Blacklist scope helpers + GuildConfig cache
│
├── models/
│   ├── Blacklist.js                # Blacklist schema (scope: global/server)
│   ├── Whitelist.js                # Whitelist schema
│   ├── Watchlist.js                # Watchlist schema (under investigation)
│   ├── TrustedUser.js              # Trusted users (cannot be blacklisted)
│   ├── PendingApproval.js          # /list add approval requests (24h TTL)
│   ├── GuildConfig.js              # Per-guild channel + notification config
│   ├── RosterCache.js              # Cached roster check results (24h TTL)
│   ├── RosterSnapshot.js           # ilvl progression tracking
│   ├── Class.js                    # Class ID → display name mapping
│   └── Raid.js                     # Raid label choices
│
└── data/
    └── status.json                 # Persisted server status state
```
