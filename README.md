# Lost Ark Discord Bot

A Discord bot that monitors Lost Ark server status (Brelshaza), supports roster lookup, and manages guild blacklist/whitelist entries.

## Main Features

- Periodically monitors Brelshaza and sends notifications when the server changes from offline/maintenance to online.
- Slash commands for quick status operations (`/status`, `/check`, `/reset`).
- `/roster` command to fetch roster data from lostark.bible (via ScraperAPI).
- `/list add` and `/list remove` to manage blacklist/whitelist entries.
- `/listcheck` command to check up to 8 names at once against blacklist/whitelist from image.
- `/listcheck` reads names from an uploaded image via Gemini.
- Optional `raid` tag and optional evidence image when adding list entries.
- Roster-based duplicate checks (`allCharacters`) with case-insensitive matching.

## Command

- `/status`: Show the latest cached status.
- `/check`: Force an immediate live check.
- `/reset`: Reset state in `data/status.json`.
- `/roster name:<character>`: Fetch roster and warn if it matches blacklist/whitelist.
- `/list add type:<black|white> name:<character> reason:<text> [raid] [image]`: Add a list entry.
- `/list remove name:<character>`: Remove an entry. If the name exists in both lists, the bot shows 3 removal options (black/white/both).
- `/listcheck image:<screenshot> [show_reason]`: Required image input. The bot sends the screenshot to Gemini, extracts up to 8 names, then returns one combined list with status icons (`⛔` blacklist, `✅` whitelist, `⛔✅` both). If a name is not in either list, the bot checks lostark.bible: `❓` means roster exists, otherwise it returns `No roster found: <name>`.

## Requirements

- Node.js >= 20
- MongoDB
- Discord bot token and channel ID
- ScraperAPI key
- Gemini API key (optional, only needed for image-based `/listcheck`)

## Environment Setup

Copy `.env.example` to `.env` and fill in all values:

- `DISCORD_TOKEN`: Discord bot token
- `CHANNEL_ID`: Notification channel ID
- `ROLE_ID`: Role ID (currently not required in code)
- `CHECK_INTERVAL`: Check interval in seconds (minimum 10, default 30)
- `MONGODB_URI`: MongoDB connection string
- `SCRAPERAPI_KEY`: API key for crawling lostark.bible
- `GEMINI_API_KEY`: optional key for Gemini image parsing in `/listcheck`
- `GEMINI_MODELS`: optional comma-separated model priority list for failover (default: `gemini-2.5-flash,gemini-3.1-flash-lite-2`)
- `GEMINI_MODEL`: backward-compatible single-model fallback if `GEMINI_MODELS` is not set

When image parsing hits Gemini free-tier quota/rate limits (for example RPM/RPD exhaustion), the bot automatically tries the next model in `GEMINI_MODELS`.

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
|- config.js
|- db.js
|- monitor.js
|- serverStatus.js
|- models/
|  |- Blacklist.js
|  |- Whitelist.js
|  |- Class.js
|  |- Raid.js
|- data/
|  |- status.json
```
