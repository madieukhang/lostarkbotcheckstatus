/**
 * app/lifecycle.js
 * Boot-time `ready` handler factory · wires DB connect, index sync,
 * slash-command registration, monitor + auto-check + emoji bootstrap
 * in the order they must run. Non-fatal subsystems (index sync, emoji
 * bootstrap) catch their own rejections so a transient failure doesn't
 * crash the boot path.
 */

import { startMonitor } from '../monitor/monitor.js';
import { setupAutoCheck } from '../handlers/list/auto-check.js';
import { bootstrapClassEmoji } from '../services/discord/emoji-bootstrap.js';
import { connectDB } from '../db.js';
import Blacklist from '../models/Blacklist.js';
import RosterCache from '../models/RosterCache.js';
import { registerCommands } from './command-registration.js';

/**
 * Build the `ready` event handler. Returned async function takes no
 * args (matches discord.js event signature). All subsystems are
 * idempotent so re-invoking on reconnect is safe.
 * @param {import('discord.js').Client} client
 * @returns {() => Promise<void>}
 */
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
