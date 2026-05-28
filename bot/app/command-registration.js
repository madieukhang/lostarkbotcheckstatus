/**
 * app/command-registration.js
 * Boot-time slash-command registration with Discord's REST API. Global
 * commands ship to every guild the bot is in; owner-guild commands
 * (admin-only utilities) are scoped to `config.ownerGuildId` so they
 * stay out of public guilds. Failure is logged + swallowed so the bot
 * still comes up · partial command surface beats no bot.
 */

import { REST, Routes } from 'discord.js';

import config from '../config.js';
import { buildCommands, buildOwnerCommands } from '../commands/index.js';

/**
 * Register slash commands at boot. Global + owner-guild sets are
 * pushed via separate REST calls so a 4xx on one set doesn't poison
 * the other.
 * @param {import('discord.js').Client} client - logged-in Discord client
 * @returns {Promise<void>}
 */
export async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('[bot] Registering global slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: buildCommands() });
    console.log('[bot] Global slash commands registered successfully.');

    if (config.ownerGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.ownerGuildId),
        { body: buildOwnerCommands() },
      );
      console.log(`[bot] Owner guild commands registered for ${config.ownerGuildId}.`);
    }
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err.message);
  }
}
