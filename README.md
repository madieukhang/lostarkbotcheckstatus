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
- **`/list add`**: Add entries with approval flow (officers auto-approve), optional raid tag, logs URL, and evidence image. Validates ilvl >= 1700.
- **`/list remove`**: Remove entries with ownership check.
- **`/list view`**: View all entries in a list.
- **Cross-server broadcast**: When entries are added/removed, notifications sent to all configured channels across servers.
- **Auto-enrich**: When a flagged character is found, background guild scan discovers and links alt characters to `allCharacters`.

### 📸 Screenshot Checking
- **`/listcheck`**: Extract up to 8 names from a screenshot via Gemini OCR, check against all lists.
- **Auto-check channels**: Drop screenshots in configured channel(s) for automatic checking (🔍 → ✅).
- **Server name filter**: Prevents OCR from extracting server names (Vairgrys, Brelshaza, etc.) as player names.
- **Gemini model failover**: Automatically switches to next model on quota/rate limits or timeout.

### ⚙️ Technical
- **Direct fetch with ScraperAPI fallback**: Fast direct access to lostark.bible, auto-fallback via proxy on 403/503.
- **Roster-based duplicate checks**: `allCharacters` field with case-insensitive matching and MongoDB index.

## Commands

| Command | Description |
|---|---|
| `/status` | Show live server status for all monitored servers |
| `/reset` | Reset the stored status state |
| `/roster name [deep]` | Fetch roster, progression delta, cross-check lists. `deep:true` runs Stronghold alt scan |
| `/search name [min_ilvl] [max_ilvl] [class]` | Search similar names (default ilvl ≥ 1700), cross-check all lists |
| `/list add type name reason [raid] [logs] [image]` | Add to blacklist/whitelist/watchlist. Officers auto-approve |
| `/list remove name` | Remove an entry (ownership check) |
| `/list view [type]` | View entries in a list (optional type, shows all if empty) |
| `/listcheck image` | OCR screenshot → check names against all lists |
| `/lastats` | Show bot usage statistics (lists, cache, uptime) |
| `/lahelp` | Show all available commands |
| `/lasetup autochannel #channel` | Set auto-check channel for this server (Manage Server) |
| `/lasetup notifychannel #channel` | Set notification channel for this server (Manage Server) |
| `/lasetup view` | View current channel configuration |
| `/lasetup reset` | Reset channel config (revert to env fallback) |

### Status Icons

| Icon | Meaning |
|---|---|
| ⛔ | Blacklisted |
| ✅ | Whitelisted |
| ⚠️ | Watchlist (under investigation) |
| ❓ | Not in any list, roster exists |

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
│       └── names.js                # Character name normalization
│
├── models/
│   ├── Blacklist.js                # Blacklist schema
│   ├── Whitelist.js                # Whitelist schema
│   ├── Watchlist.js                # Watchlist schema (under investigation)
│   ├── PendingApproval.js          # /list add approval requests (24h TTL)
│   ├── GuildConfig.js              # Per-guild channel configuration
│   ├── RosterSnapshot.js           # ilvl progression tracking
│   ├── Class.js                    # Class ID → display name mapping
│   └── Raid.js                     # Raid label choices
│
└── data/
    └── status.json                 # Persisted server status state
```
