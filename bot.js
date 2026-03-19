/**
 * bot.js
 * Entry point for the Lost Ark server-status Discord bot.
 */

import {
  Client,
  GatewayIntentBits,
  InteractionType,
  REST,
  Routes,
} from 'discord.js';

import config from './config.js';
import { startMonitor, checkStatus, getState, resetState } from './monitor.js';
import { buildCommands } from './bot/commands.js';
import { createSystemHandlers } from './bot/handlers/systemHandlers.js';
import { handleRosterCommand } from './bot/handlers/rosterHandler.js';
import { createListHandlers } from './bot/handlers/listHandlers.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const systemHandlers = createSystemHandlers({
  getState,
  checkStatus,
  resetState,
  client,
});

const listHandlers = createListHandlers({ client });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('[bot] Registering global slash commands…');
    await rest.put(Routes.applicationCommands(client.user.id), { body: buildCommands() });
    console.log('[bot] Global slash commands registered successfully.');
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  await registerCommands();
  startMonitor(client);
});

client.on('interactionCreate', async (interaction) => {
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('listadd_approve:') || interaction.customId.startsWith('listadd_reject:'))
  ) {
    try {
      await listHandlers.handleListAddApprovalButton(interaction);
    } catch (err) {
      console.error('[list] Unhandled button approval error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Failed to process approval action.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Failed to process approval action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await systemHandlers.handleStatusCommand(interaction);
    } else if (commandName === 'check') {
      await systemHandlers.handleCheckCommand(interaction);
    } else if (commandName === 'reset') {
      await systemHandlers.handleResetCommand(interaction);
    } else if (commandName === 'roster') {
      await handleRosterCommand(interaction);
    } else if (commandName === 'list') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        await listHandlers.handleListAddCommand(interaction);
      } else if (subcommand === 'remove') {
        await listHandlers.handleListRemoveCommand(interaction);
      }
    } else if (commandName === 'listcheck') {
      await listHandlers.handleListCheckCommand(interaction);
    }
  } catch (err) {
    console.error(`[bot] Unhandled error in /${commandName}:`, err);

    const reply = { content: '❌ An unexpected error occurred.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  process.exit(1);
});

client.login(config.token);
