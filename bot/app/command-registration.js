import { REST, Routes } from 'discord.js';

import config from '../config.js';
import { buildCommands, buildOwnerCommands } from '../commands/index.js';

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
