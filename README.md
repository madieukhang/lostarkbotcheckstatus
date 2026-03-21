# Lost Ark Discord Bot

A Discord bot that monitors Lost Ark server status, supports roster lookup, manages guild blacklist/whitelist/watchlist entries, and detects alt characters via Stronghold fingerprinting.

## Main Features

### Server Monitoring
- **Multi-server monitoring**: Monitors one or more servers (e.g. Brelshaza, Thaemine) with a single page fetch.
- **Auto-notification**: Sends `@here` when servers transition from offline/maintenance to online.
- **`/status`**: Live server status check on demand.

### Roster & Character Lookup
- **`/roster`**: Fetch roster from lostark.bible with progression tracking (shows ilvl delta since last check).
- **`/search`**: Find similar character names with filters (ilvl range, class) and cross-check against all lists.
- **Alt detection**: When roster is hidden, detects alt characters via Stronghold name + Roster Level matching across guild members.
- **Guild member check**: When roster is hidden, checks all guild members against all lists.
- **OCR similar suggestions**: When Gemini misreads diacritics, shows similar names with list flags (e.g. `⛔ Lùcifër, ❓ Lucifer`).

### List Management
- **Blacklist / Whitelist / Watchlist**: Three list types with `⛔`, `✅`, `⚠️` icons.
- **`/list add`**: Add entries with approval flow (officers auto-approve), optional raid tag, logs URL, and evidence image. Validates ilvl >= 1700.
- **`/list remove`**: Remove entries with ownership check.
- **`/list view`**: View all entries in a list.
- **Cross-server broadcast**: When entries are added/removed, notifications sent to all configured channels across servers.
- **Auto-enrich**: When a flagged character is found, background guild scan discovers and links alt characters to `allCharacters`.

### Screenshot Checking
- **`/listcheck`**: Extract up to 8 names from a screenshot via Gemini OCR, check against all lists.
- **Auto-check channels**: Drop screenshots in configured channel(s) for automatic checking (🔍 → ✅).
- **Server name filter**: Prevents OCR from extracting server names (Vairgrys, Brelshaza, etc.) as player names.
- **Gemini model failover**: Automatically switches to next model on quota/rate limits or timeout.

### Technical
- **Direct fetch with ScraperAPI fallback**: Fast direct access to lostark.bible, auto-fallback via proxy on 403/503.
- **Roster-based duplicate checks**: `allCharacters` field with case-insensitive matching and MongoDB index.
- **`/help`**: Shows all available commands.

## Commands

- `/status`: Show live server status for all monitored servers.
- `/reset`: Reset state in `data/status.json`.
- `/roster name:<character>`: Fetch roster, show progression delta, cross-check lists. If roster is hidden: detect alts via Stronghold fingerprint + check guild members against lists.
- `/search name:<character> [min_ilvl] [max_ilvl] [class]`: Search lostark.bible for similar names (default ilvl ≥ 1700), cross-check against all lists. Optional filters: item level range, class.
- `/list add type:<black|white|watch> name:<character> reason:<text> [raid] [logs] [image]`: Create an add proposal. Officers/senior auto-approve; others go through DM approval flow. Optional logs URL for evidence.
- `/list remove name:<character>`: Remove an entry. If the name exists in multiple lists, shows removal options.
- `/list view type:<black|white|watch>`: View all entries in a list.
- `/listcheck image:<screenshot>`: Extract names from screenshot via Gemini OCR, check against all lists. Status icons: `⛔` blacklist, `✅` whitelist, `⚠️` watchlist, `❓` roster exists, `No roster found`. Background: auto-enriches alt data for flagged entries.
- `/help`: Show all available commands.

## Requirements

- Node.js >= 20
- MongoDB
- Discord bot token and channel ID
- Gemini API key (optional, needed for `/listcheck` and auto-check)
- Discord Privileged Intent: **Message Content Intent** (needed for auto-check channel feature)

## Environment Setup

Copy `.env.example` to `.env` and fill in required values:

### Required
- `DISCORD_TOKEN`: Discord bot token
- `CHANNEL_ID`: Notification channel ID
- `MONGODB_URI`: MongoDB connection string

### Optional
- `CHECK_INTERVAL`: Check interval in seconds (minimum 10, default 30)
- `TARGET_SERVERS`: Comma-separated server names to monitor (default: `Brelshaza`). Example: `Brelshaza,Thaemine`
- `GEMINI_API_KEY`: Key for Gemini image parsing in `/listcheck` and auto-check
- `GEMINI_MODELS`: Comma-separated model priority list for failover (default: `gemini-2.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3-flash`)
- `AUTO_CHECK_CHANNEL_IDS`: Comma-separated channel IDs for auto-check (drop image → auto listcheck)
- `LIST_NOTIFY_CHANNEL_IDS`: Comma-separated channel IDs to broadcast list add/remove notifications across servers
- `SCRAPERAPI_KEY`: Optional but recommended — used as automatic fallback when lostark.bible blocks direct access (403/503)

When image parsing hits Gemini free-tier quota/rate limits, the bot automatically tries the next model in `GEMINI_MODELS`.

## Run Locally

```bash
npm install
npm start
```

Dev mode:

```bash
npm run dev
```

## Run with Docker

```bash
docker build -t lostark-discord-bot .
docker run --env-file .env --name lostark-bot lostark-discord-bot
```

## Deploy on Railway

- This repository already includes `Dockerfile` and `railway.toml`.
- Set environment variables in the Railway Variables tab (do not upload `.env`).
- Start command: `node bot.js`.

## Project Structure

```text
.
|- bot.js
|- bot/
|  |- commands.js
|  |- handlers/
|  |  |- systemHandlers.js
|  |  |- rosterHandler.js
|  |  |- listHandlers.js
|  |  |- searchHandler.js
|  |  |- autoCheckHandler.js
|  |- services/
|  |  |- rosterService.js
|  |  |- listCheckService.js
|  |- utils/
|  |  |- names.js
|- config.js
|- db.js
|- monitor.js
|- serverStatus.js
|- models/
|  |- Blacklist.js
|  |- Whitelist.js
|  |- Watchlist.js
|  |- Class.js
|  |- Raid.js
|  |- PendingApproval.js
|  |- RosterSnapshot.js
|- data/
|  |- status.json
```
