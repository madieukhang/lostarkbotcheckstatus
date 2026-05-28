/**
 * app/interaction-router.js
 * Central interaction dispatcher for every Discord interaction the bot
 * cares about. Routes by interaction type (slash command, button,
 * select-menu, modal, autocomplete) then by command name or component
 * prefix. Transient 10062/40060 errors (3-second Discord ACK window
 * expiry, double-ack) are logged + swallowed · everything else
 * bubbles to a generic error reply so the user never stares at a
 * silent failure.
 */

import { InteractionType } from 'discord.js';

import { checkStatus, resetState } from '../monitor/monitor.js';
import { createSystemHandlers } from '../handlers/system/index.js';
import { handleRosterCommand, handleRosterDeepContinueButton } from '../handlers/roster/index.js';
import {
  createListHandlers,
  handleListEvidenceAutocomplete,
} from '../handlers/list/index.js';
import { handleSearchCommand } from '../handlers/search/index.js';
import { handleSetupCommand, handleSetupRemoteCommand } from '../handlers/setup/index.js';
import { handleStatsCommand } from '../handlers/meta/stats.js';
import { handleHelpCommand, handleHelpSelect } from '../handlers/meta/help.js';
import {
  handleLanguageSwitchCommand,
  handleLanguageSwitchSelect,
  LANGUAGE_SWITCH_SELECT_CUSTOM_ID,
} from '../handlers/meta/languageSwitch.js';
import { getClassAutocompleteChoices } from '../models/Class.js';

function hasPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isTransientInteractionError(err) {
  return err?.code === 10062 || err?.code === 40060;
}

function logTransientInteraction(scope, err) {
  const label = err.code === 10062
    ? 'Unknown interaction (3s window expired)'
    : 'Interaction already acknowledged';
  console.warn(`[bot] Transient on ${scope}: ${label} (${err.code})`);
}

async function replyOrEdit(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch(() => {});
    return;
  }
  await interaction.reply({ content, ephemeral: true }).catch(() => {});
}

async function handleButton(interaction, label, handler, failureContent = null) {
  try {
    await handler(interaction);
  } catch (err) {
    console.error(label, err?.message || err);
    if (failureContent) {
      await replyOrEdit(interaction, failureContent);
    }
  }
}

async function handleAutocomplete(interaction) {
  try {
    if (interaction.commandName === 'la-search') {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === 'class') {
        await interaction.respond(getClassAutocompleteChoices(focused.value));
        return;
      }
    }
    if (interaction.commandName === 'la-evidence') {
      await handleListEvidenceAutocomplete(interaction);
      return;
    }
    await interaction.respond([]);
  } catch (err) {
    console.error('[bot] Autocomplete error:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

export function createInteractionRouter({ client }) {
  const systemHandlers = createSystemHandlers({
    checkStatus,
    resetState,
    client,
  });
  const listHandlers = createListHandlers({ client });

  return async function handleInteraction(interaction) {
    const customId = interaction.customId || '';

    if (interaction.isButton() && hasPrefix(customId, ['listadd_overwrite:', 'listadd_keep:'])) {
      await handleButton(interaction, '[list] Overwrite button error:', (i) =>
        listHandlers.handleListAddOverwriteButton(i),
      );
      return;
    }

    if (interaction.isButton() && hasPrefix(customId, ['listadd_approve:', 'listadd_reject:'])) {
      await handleButton(
        interaction,
        '[list] Unhandled button approval error:',
        (i) => listHandlers.handleListAddApprovalButton(i),
        '❌ Failed to process approval action.',
      );
      return;
    }

    if (interaction.isButton() && customId.startsWith('listadd_viewevidence:')) {
      await handleButton(
        interaction,
        '[list] View evidence button error:',
        (i) => listHandlers.handleListAddViewEvidenceButton(i),
        '❌ Failed to load evidence.',
      );
      return;
    }

    if (interaction.isButton() && hasPrefix(customId, [
      'list-enrich:confirm:',
      'list-enrich:cancel:',
      'list-enrich:continue:',
    ])) {
      await handleButton(interaction, '[list] Enrich button error:', async (i) => {
        if (customId.startsWith('list-enrich:confirm:')) {
          await listHandlers.handleListEnrichConfirmButton(i);
        } else if (customId.startsWith('list-enrich:continue:')) {
          await listHandlers.handleListEnrichContinueButton(i);
        } else {
          await listHandlers.handleListEnrichCancelButton(i);
        }
      }, '❌ Failed to process enrich action.');
      return;
    }

    if (interaction.isButton() && customId.startsWith('roster-deep:continue:')) {
      await handleButton(
        interaction,
        '[roster] deep continue button error:',
        handleRosterDeepContinueButton,
        '❌ Failed to continue deep scan.',
      );
      return;
    }

    if (interaction.isButton() && customId.startsWith('list-add:enrich-hidden:')) {
      await handleButton(
        interaction,
        '[list] add->enrich button error:',
        (i) => listHandlers.handleListAddEnrichHiddenButton(i),
        '❌ Failed to start enrich scan.',
      );
      return;
    }

    if (interaction.isButton() && customId.startsWith('scan-cancel:')) {
      await handleButton(
        interaction,
        '[scan] cancel button error:',
        (i) => listHandlers.handleScanCancelButton(i),
        '❌ Failed to send stop signal.',
      );
      return;
    }

    if (interaction.isButton() && hasPrefix(customId, ['multiadd_confirm:', 'multiadd_cancel:'])) {
      await handleButton(
        interaction,
        '[multiadd] Button handler error:',
        (i) => listHandlers.handleMultiaddConfirmButton(i),
        '❌ Failed to process button action.',
      );
      return;
    }

    if (interaction.isButton() && hasPrefix(customId, [
      'multiaddapprove_approve:',
      'multiaddapprove_reject:',
    ])) {
      await handleButton(
        interaction,
        '[multiadd] Approval button error:',
        (i) => listHandlers.handleMultiaddApprovalButton(i),
        '❌ Failed to process approval action.',
      );
      return;
    }

    if (interaction.isStringSelectMenu() && customId === 'quickadd_select') {
      await handleButton(interaction, '[quickadd] Select error:', (i) =>
        listHandlers.handleQuickAddSelect(i),
      );
      return;
    }

    if (interaction.isStringSelectMenu() && customId === 'autocheck_evidence') {
      await handleButton(
        interaction,
        '[autocheck] Evidence select error:',
        (i) => listHandlers.handleAutoCheckEvidenceSelect(i),
        '❌ Failed to load evidence.',
      );
      return;
    }

    if (interaction.isStringSelectMenu() && customId.startsWith('la-help:select:')) {
      await handleButton(interaction, '[la-help] Select error:', handleHelpSelect);
      return;
    }

    if (interaction.isStringSelectMenu() && customId === LANGUAGE_SWITCH_SELECT_CUSTOM_ID) {
      await handleButton(interaction, '[la-language-switch] Select error:', handleLanguageSwitchSelect);
      return;
    }

    if (interaction.isModalSubmit() && customId.startsWith('quickadd_modal:')) {
      try {
        await listHandlers.handleQuickAddModal(interaction);
      } catch (err) {
        console.error('[quickadd] Modal error:', err.message);
        await replyOrEdit(interaction, `⚠️ Failed: \`${err.message}\``);
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.type !== InteractionType.ApplicationCommand) return;

    const { commandName } = interaction;

    try {
      if (commandName === 'la-status') {
        await systemHandlers.handleStatusCommand(interaction);
      } else if (commandName === 'la-reset') {
        await systemHandlers.handleResetCommand(interaction);
      } else if (commandName === 'la-roster') {
        await handleRosterCommand(interaction);
      } else if (commandName === 'la-search') {
        await handleSearchCommand(interaction);
      } else if (commandName === 'la-evidence') {
        await listHandlers.handleListEvidenceCommand(interaction);
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
      } else if (commandName === 'la-language-switch') {
        await handleLanguageSwitchCommand(interaction);
      }
    } catch (err) {
      if (isTransientInteractionError(err)) {
        logTransientInteraction(`/${commandName}`, err);
        return;
      }

      console.error(`[bot] Unhandled error in /${commandName}:`, err);

      try {
        await replyOrEdit(interaction, '❌ An unexpected error occurred.');
      } catch (replyErr) {
        if (!isTransientInteractionError(replyErr)) {
          console.warn(`[bot] Failed to send error reply on /${commandName}:`, replyErr.message);
        }
      }
    }
  };
}
