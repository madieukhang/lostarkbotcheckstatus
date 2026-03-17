# Lost Ark Discord Bot

A Discord bot that monitors Lost Ark server status (Brelshaza), supports roster lookup, and manages guild blacklist/whitelist entries.

## Main Features

- Periodically monitors Brelshaza and sends notifications when the server changes from offline/maintenance to online.
- Slash commands for quick status operations (`/status`, `/check`, `/reset`).
- `/roster` command to fetch roster data from lostark.bible (via ScraperAPI).
- `/list add` and `/list remove` to manage blacklist/whitelist entries.
- Optional `raid` tag and optional evidence image when adding list entries.
- Roster-based duplicate checks (`allCharacters`) with case-insensitive matching.

## Command

- `/status`: Show the latest cached status.
- `/check`: Force an immediate live check.
- `/reset`: Reset state in `data/status.json`.
- `/roster name:<character>`: Fetch roster and warn if it matches blacklist/whitelist.
- `/list add type:<black|white> name:<character> reason:<text> [raid] [image]`: Add a list entry.
- `/list remove name:<character>`: Remove an entry. If the name exists in both lists, the bot shows 3 removal options (black/white/both).

## Requirements

- Node.js >= 20
- MongoDB
- Discord bot token and channel ID
- ScraperAPI key

## Environment Setup

Copy `.env.example` to `.env` and fill in all values:

- `DISCORD_TOKEN`: Discord bot token
- `CHANNEL_ID`: Notification channel ID
- `ROLE_ID`: Role ID (currently not required in code)
- `CHECK_INTERVAL`: Check interval in seconds (minimum 10, default 30)
- `MONGODB_URI`: MongoDB connection string
- `SCRAPERAPI_KEY`: API key for crawling lostark.bible

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
