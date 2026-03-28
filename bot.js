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
import { startMonitor, checkStatus, resetState } from './monitor.js';
import { buildCommands } from './bot/commands.js';
import { createSystemHandlers } from './bot/handlers/systemHandlers.js';
import { handleRosterCommand } from './bot/handlers/rosterHandler.js';
import { createListHandlers } from './bot/handlers/listHandlers.js';
import { handleSearchCommand } from './bot/handlers/searchHandler.js';
import { setupAutoCheck } from './bot/handlers/autoCheckHandler.js';
import { handleSetupCommand } from './bot/handlers/setupHandler.js';
import { handleStatsCommand } from './bot/handlers/statsHandler.js';
import { connectDB } from './db.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const systemHandlers = createSystemHandlers({
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
  await connectDB();
  await registerCommands();
  startMonitor(client);
  setupAutoCheck(client);
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

  // Quick Add: select menu → show modal
  if (interaction.isStringSelectMenu() && interaction.customId === 'quickadd_select') {
    try {
      await listHandlers.handleQuickAddSelect(interaction);
    } catch (err) {
      console.error('[quickadd] Select error:', err.message);
    }
    return;
  }

  // Quick Add: modal submit → process add
  if (interaction.isModalSubmit() && interaction.customId.startsWith('quickadd_modal:')) {
    try {
      await listHandlers.handleQuickAddModal(interaction);
    } catch (err) {
      console.error('[quickadd] Modal error:', err.message);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `⚠️ Failed: \`${err.message}\`` }).catch(() => {});
      } else {
        await interaction.reply({ content: `⚠️ Failed: \`${err.message}\``, ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'status') {
      await systemHandlers.handleStatusCommand(interaction);
    } else if (commandName === 'reset') {
      await systemHandlers.handleResetCommand(interaction);
    } else if (commandName === 'roster') {
      await handleRosterCommand(interaction);
    } else if (commandName === 'search') {
      await handleSearchCommand(interaction);
    } else if (commandName === 'list') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        await listHandlers.handleListAddCommand(interaction);
      } else if (subcommand === 'remove') {
        await listHandlers.handleListRemoveCommand(interaction);
      } else if (subcommand === 'view') {
        await listHandlers.handleListViewCommand(interaction);
      }
    } else if (commandName === 'listcheck') {
      await listHandlers.handleListCheckCommand(interaction);
    } else if (commandName === 'lastats') {
      await handleStatsCommand(interaction);
    } else if (commandName === 'lasetup') {
      await handleSetupCommand(interaction);
    } else if (commandName === 'lahelp') {
      const helpText = [
        '**📋 Available Commands:**',
        '',
        '`/status` — Show live server status for all monitored servers',
        '`/reset` — Reset the stored status state',
        '',
        '`/roster name` — Fetch roster + progression tracking + list check',
        '`/search name [min_ilvl] [max_ilvl] [class]` — Search similar names with filters',
        '',
        '`/list add type name reason [raid] [logs] [image]` — Add to blacklist/whitelist/watchlist',
        '`/list remove name` — Remove an entry from a list',
        '`/list view type` — View all entries in a list',
        '',
        '`/listcheck image` — Check names from screenshot against all lists',
        '',
        '`/lastats` — Show bot usage statistics',
        '',
        '`/lasetup autochannel #channel` — Set auto-check channel for this server',
        '`/lasetup notifychannel #channel` — Set notification channel for this server',
        '`/lasetup view` — View current channel configuration',
        '`/lasetup reset` — Reset channel config (revert to env fallback)',
      ].join('\n');

      await interaction.reply({ content: helpText, ephemeral: true });
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
