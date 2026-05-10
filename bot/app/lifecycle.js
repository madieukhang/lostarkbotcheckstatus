import { startMonitor } from '../monitor/monitor.js';
import { setupAutoCheck } from '../handlers/list/auto-check.js';
import { bootstrapClassEmoji } from '../services/discord/emoji-bootstrap.js';
import { connectDB } from '../db.js';
import Blacklist from '../models/Blacklist.js';
import RosterCache from '../models/RosterCache.js';
import { registerCommands } from './command-registration.js';

export function createReadyHandler(client) {
  return async () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);
    await connectDB();

    Blacklist.syncIndexes().catch((err) =>
      console.warn('[bot] Blacklist syncIndexes:', err.message),
    );
    RosterCache.syncIndexes().catch((err) =>
      console.warn('[bot] RosterCache syncIndexes:', err.message),
    );

    await registerCommands(client);
    startMonitor(client);
    setupAutoCheck(client);

    bootstrapClassEmoji(client).catch((err) =>
      console.warn('[bot] class-emoji bootstrap rejected (non-fatal):', err?.message || err),
    );
  };
}
