/**
 * bot.js
 * Entry point for the Lost Ark server-status Discord bot.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionType,
  REST,
  Routes,
} from 'discord.js';

import config from './bot/config.js';
import { startMonitor, checkStatus, resetState } from './bot/monitor/monitor.js';
import { buildCommands, buildOwnerCommands } from './bot/commands.js';
import { createSystemHandlers } from './bot/handlers/systemHandlers.js';
import { handleRosterCommand } from './bot/handlers/rosterHandler.js';
import { createListHandlers } from './bot/handlers/listHandlers.js';
import { handleSearchCommand } from './bot/handlers/searchHandler.js';
import { setupAutoCheck } from './bot/handlers/autoCheckHandler.js';
import { handleSetupCommand, handleSetupRemoteCommand } from './bot/handlers/setupHandler.js';
import { handleStatsCommand } from './bot/handlers/statsHandler.js';
import { handleHelpCommand } from './bot/handlers/helpHandler.js';
import { connectDB } from './bot/db.js';
import Blacklist from './bot/models/Blacklist.js';
import RosterCache from './bot/models/RosterCache.js';
import { getClassAutocompleteChoices } from './bot/models/Class.js';

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

    // Register owner-guild-only commands (guild-specific = instant, invisible to other servers)
    if (config.ownerGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.ownerGuildId),
        { body: buildOwnerCommands() }
      );
      console.log(`[bot] Owner guild commands registered for ${config.ownerGuildId}.`);
    }
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err.message);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  await connectDB();

  // Sync blacklist indexes (drops old name-only unique, creates compound name+scope+guildId)
  Blacklist.syncIndexes().catch((err) =>
    console.warn('[bot] Blacklist syncIndexes:', err.message)
  );
  RosterCache.syncIndexes().catch((err) =>
    console.warn('[bot] RosterCache syncIndexes:', err.message)
  );

  await registerCommands();
  startMonitor(client);
  setupAutoCheck(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('listadd_overwrite:') || interaction.customId.startsWith('listadd_keep:'))
  ) {
    try {
      await listHandlers.handleListAddOverwriteButton(interaction);
    } catch (err) {
      console.error('[list] Overwrite button error:', err.message);
    }
    return;
  }

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

  // /list add approval — "📎 View Evidence (Fresh)" button on approver DMs
  if (
    interaction.isButton() &&
    interaction.customId.startsWith('listadd_viewevidence:')
  ) {
    try {
      await listHandlers.handleListAddViewEvidenceButton(interaction);
    } catch (err) {
      console.error('[list] View evidence button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to load evidence.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /list enrich confirm/cancel buttons
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('list-enrich:confirm:') ||
      interaction.customId.startsWith('list-enrich:cancel:'))
  ) {
    try {
      const isConfirm = interaction.customId.startsWith('list-enrich:confirm:');
      if (isConfirm) {
        await listHandlers.handleListEnrichConfirmButton(interaction);
      } else {
        await listHandlers.handleListEnrichCancelButton(interaction);
      }
    } catch (err) {
      console.error('[list] Enrich button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to process enrich action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // "Enrich now" button posted on /la-list add success cards when the
  // entry was created against a hidden roster. Lets an officer trigger
  // /la-list enrich for the entry without re-typing the name.
  if (
    interaction.isButton() &&
    interaction.customId.startsWith('list-add:enrich-hidden:')
  ) {
    try {
      await listHandlers.handleListAddEnrichHiddenButton(interaction);
    } catch (err) {
      console.error('[list] add->enrich button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to start enrich scan.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // Stop-scan button on the live progress embed for /la-list enrich and
  // /la-roster deep:true. Flips the shared cancel flag; the detector
  // exits on its next candidate loop check.
  if (
    interaction.isButton() &&
    interaction.customId.startsWith('scan-cancel:')
  ) {
    try {
      await listHandlers.handleScanCancelButton(interaction);
    } catch (err) {
      console.error('[scan] cancel button error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Failed to send stop signal.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /la-list multiadd preview Confirm/Cancel buttons
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('multiadd_confirm:') || interaction.customId.startsWith('multiadd_cancel:'))
  ) {
    try {
      await listHandlers.handleMultiaddConfirmButton(interaction);
    } catch (err) {
      console.error('[multiadd] Button handler error:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Failed to process button action.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Failed to process button action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // /la-list multiadd bulk approval buttons (DM to Senior)
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('multiaddapprove_approve:') ||
      interaction.customId.startsWith('multiaddapprove_reject:'))
  ) {
    try {
      await listHandlers.handleMultiaddApprovalButton(interaction);
    } catch (err) {
      console.error('[multiadd] Approval button error:', err);
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

  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === 'la-search') {
        const focused = interaction.options.getFocused(true);
        if (focused?.name === 'class') {
          await interaction.respond(getClassAutocompleteChoices(focused.value));
          return;
        }
      }
      await interaction.respond([]);
    } catch (err) {
      console.error('[bot] Autocomplete error:', err.message);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (interaction.type !== InteractionType.ApplicationCommand) return;

  const { commandName } = interaction;

  // Phase 4c+4d (2026-05-03): every bot command lives under the
  // `la-` prefix. Legacy aliases and the soft-deprecation banner are
  // both gone; Discord drops unregistered slash names on its side, so
  // any stale legacy invocation never reaches this dispatch.
  try {
    if (commandName === 'la-status') {
      await systemHandlers.handleStatusCommand(interaction);
    } else if (commandName === 'la-reset') {
      await systemHandlers.handleResetCommand(interaction);
    } else if (commandName === 'la-roster') {
      await handleRosterCommand(interaction);
    } else if (commandName === 'la-search') {
      await handleSearchCommand(interaction);
    } else if (commandName === 'la-list') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') {
        await listHandlers.handleListAddCommand(interaction);
      } else if (subcommand === 'edit') {
        await listHandlers.handleListEditCommand(interaction);
      } else if (subcommand === 'remove') {
        await listHandlers.handleListRemoveCommand(interaction);
      } else if (subcommand === 'view') {
        await listHandlers.handleListViewCommand(interaction);
      } else if (subcommand === 'trust') {
        await listHandlers.handleListTrustCommand(interaction);
      } else if (subcommand === 'multiadd') {
        await listHandlers.handleListMultiaddCommand(interaction);
      } else if (subcommand === 'enrich') {
        await listHandlers.handleListEnrichCommand(interaction);
      }
    } else if (commandName === 'la-check') {
      await listHandlers.handleListCheckCommand(interaction);
    } else if (commandName === 'la-stats') {
      await handleStatsCommand(interaction);
    } else if (commandName === 'la-setup') {
      await handleSetupCommand(interaction);
    } else if (commandName === 'la-remote') {
      await handleSetupRemoteCommand(interaction);
    } else if (commandName === 'la-help') {
      await handleHelpCommand(interaction);
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
