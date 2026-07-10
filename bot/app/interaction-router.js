/**
 * app/interaction-router.js
 * Central interaction dispatcher for every Discord interaction the bot
 * cares about. Route tables keep the command/component surface visible
 * without growing another long if/else chain.
 */

import { InteractionType, MessageFlags } from 'discord.js';

import { checkStatus, resetState } from '../monitor/monitor.js';
import { AlertSeverity, buildAlertEmbed } from '../utils/alertEmbed.js';
import { getCachedUserLanguage, t } from '../services/i18n/index.js';
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

async function replyOrEdit(interaction) {
  const lang = getCachedUserLanguage(interaction.user?.id);
  const payload = {
    embeds: [buildAlertEmbed({
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.unexpected', lang),
      lang,
    })],
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: null, ...payload }).catch(() => {});
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

async function handleRoute(interaction, route) {
  try {
    await route.handle(interaction);
  } catch (err) {
    if (route.onError) {
      await route.onError(interaction, err);
      return;
    }
    console.error(route.label, err?.message || err);
    await replyOrEdit(interaction);
  }
}

function createAutocompleteRoutes() {
  return {
    'la-search': async (interaction) => {
      const focused = interaction.options.getFocused(true);
      const choices = focused?.name === 'class'
        ? getClassAutocompleteChoices(focused.value)
        : [];
      await interaction.respond(choices);
    },
    'la-evidence': handleListEvidenceAutocomplete,
  };
}

async function handleAutocomplete(interaction, autocompleteRoutes = createAutocompleteRoutes()) {
  try {
    const handler = autocompleteRoutes[interaction.commandName];
    if (handler) {
      await handler(interaction);
      return;
    }
    await interaction.respond([]);
  } catch (err) {
    console.error('[bot] Autocomplete error:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

function createListEnrichButtonHandler(listHandlers) {
  return async (interaction) => {
    const customId = interaction.customId || '';
    if (customId.startsWith('list-enrich:confirm:')) {
      await listHandlers.handleListEnrichConfirmButton(interaction);
      return;
    }
    if (customId.startsWith('list-enrich:continue:')) {
      await listHandlers.handleListEnrichContinueButton(interaction);
      return;
    }
    await listHandlers.handleListEnrichCancelButton(interaction);
  };
}

export function findCustomIdRoute(routes, customId) {
  return routes.find((route) => {
    if (route.exact && customId === route.exact) return true;
    if (route.prefixes && hasPrefix(customId, route.prefixes)) return true;
    return false;
  });
}

export function createButtonRoutes(listHandlers) {
  return [
    {
      prefixes: ['listadd_overwrite:', 'listadd_keep:'],
      label: '[list] Overwrite button error:',
      handle: (interaction) => listHandlers.handleListAddOverwriteButton(interaction),
    },
    {
      prefixes: ['listadd_approve:', 'listadd_reject:'],
      label: '[list] Unhandled button approval error:',
      handle: (interaction) => listHandlers.handleListAddApprovalButton(interaction),
    },
    {
      prefixes: ['listadd_viewevidence:'],
      label: '[list] View evidence button error:',
      handle: (interaction) => listHandlers.handleListAddViewEvidenceButton(interaction),
    },
    {
      prefixes: ['listbroadcast_evidence:'],
      label: '[list] Broadcast evidence button error:',
      handle: (interaction) => listHandlers.handleBroadcastEvidenceButton(interaction),
    },
    {
      prefixes: [
        'list-enrich:confirm:',
        'list-enrich:cancel:',
        'list-enrich:continue:',
      ],
      label: '[list] Enrich button error:',
      handle: createListEnrichButtonHandler(listHandlers),
    },
    {
      prefixes: ['roster-deep:continue:'],
      label: '[roster] deep continue button error:',
      handle: handleRosterDeepContinueButton,
    },
    {
      prefixes: ['list-add:enrich-hidden:'],
      label: '[list] add->enrich button error:',
      handle: (interaction) => listHandlers.handleListAddEnrichHiddenButton(interaction),
    },
    {
      prefixes: ['scan-cancel:'],
      label: '[scan] cancel button error:',
      handle: (interaction) => listHandlers.handleScanCancelButton(interaction),
    },
    {
      prefixes: ['multiadd_confirm:', 'multiadd_cancel:'],
      label: '[multiadd] Button handler error:',
      handle: (interaction) => listHandlers.handleMultiaddConfirmButton(interaction),
    },
    {
      prefixes: [
        'multiaddapprove_approve:',
        'multiaddapprove_reject:',
      ],
      label: '[multiadd] Approval button error:',
      handle: (interaction) => listHandlers.handleMultiaddApprovalButton(interaction),
    },
  ];
}

export function createSelectRoutes(listHandlers) {
  return [
    {
      exact: 'quickadd_select',
      label: '[quickadd] Select error:',
      handle: (interaction) => listHandlers.handleQuickAddSelect(interaction),
    },
    {
      exact: 'autocheck_evidence',
      label: '[autocheck] Evidence select error:',
      handle: (interaction) => listHandlers.handleAutoCheckEvidenceSelect(interaction),
    },
    {
      prefixes: ['la-help:select:'],
      label: '[la-help] Select error:',
      handle: handleHelpSelect,
    },
    {
      exact: LANGUAGE_SWITCH_SELECT_CUSTOM_ID,
      label: '[la-language-switch] Select error:',
      handle: handleLanguageSwitchSelect,
    },
  ];
}

function createModalRoutes(listHandlers) {
  return [
    {
      prefixes: ['quickadd_modal:'],
      handle: (interaction) => listHandlers.handleQuickAddModal(interaction),
      onError: async (interaction, err) => {
        console.error('[quickadd] Modal error:', err.message);
        await replyOrEdit(interaction);
      },
    },
  ];
}

export function createCommandRoutes({ systemHandlers, listHandlers }) {
  return {
    'la-status': systemHandlers.handleStatusCommand,
    'la-reset': systemHandlers.handleResetCommand,
    'la-roster': handleRosterCommand,
    'la-search': handleSearchCommand,
    'la-evidence': listHandlers.handleListEvidenceCommand,
    'la-list': {
      subcommands: {
        add: listHandlers.handleListAddCommand,
        edit: listHandlers.handleListEditCommand,
        remove: listHandlers.handleListRemoveCommand,
        view: listHandlers.handleListViewCommand,
        trust: listHandlers.handleListTrustCommand,
        multiadd: listHandlers.handleListMultiaddCommand,
        enrich: listHandlers.handleListEnrichCommand,
      },
    },
    'la-check': listHandlers.handleListCheckCommand,
    'la-stats': handleStatsCommand,
    'la-setup': handleSetupCommand,
    'la-remote': handleSetupRemoteCommand,
    'la-help': handleHelpCommand,
    'la-language-switch': handleLanguageSwitchCommand,
  };
}

export async function dispatchCommandRoute(interaction, commandRoutes) {
  const route = commandRoutes[interaction.commandName];
  if (!route) return false;

  if (route.subcommands) {
    const subcommand = interaction.options.getSubcommand();
    const handler = route.subcommands[subcommand];
    if (handler) await handler(interaction);
    return true;
  }

  await route(interaction);
  return true;
}

export function createInteractionRouter({ client }) {
  const systemHandlers = createSystemHandlers({
    checkStatus,
    resetState,
    client,
  });
  const listHandlers = createListHandlers({ client });
  const autocompleteRoutes = createAutocompleteRoutes();
  const buttonRoutes = createButtonRoutes(listHandlers);
  const selectRoutes = createSelectRoutes(listHandlers);
  const modalRoutes = createModalRoutes(listHandlers);
  const commandRoutes = createCommandRoutes({ systemHandlers, listHandlers });

  return async function handleInteraction(interaction) {
    const customId = interaction.customId || '';

    if (interaction.isButton()) {
      const route = findCustomIdRoute(buttonRoutes, customId);
      if (route) await handleRoute(interaction, route);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const route = findCustomIdRoute(selectRoutes, customId);
      if (route) await handleRoute(interaction, route);
      return;
    }

    if (interaction.isModalSubmit()) {
      const route = findCustomIdRoute(modalRoutes, customId);
      if (route) await handleRoute(interaction, route);
      return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, autocompleteRoutes);
      return;
    }

    if (interaction.type !== InteractionType.ApplicationCommand) return;

    const { commandName } = interaction;

    try {
      await dispatchCommandRoute(interaction, commandRoutes);
    } catch (err) {
      if (isTransientInteractionError(err)) {
        logTransientInteraction(`/${commandName}`, err);
        return;
      }

      console.error(`[bot] Unhandled error in /${commandName}:`, err);

      try {
        await replyOrEdit(interaction);
      } catch (replyErr) {
        if (!isTransientInteractionError(replyErr)) {
          console.warn(`[bot] Failed to send error reply on /${commandName}:`, replyErr.message);
        }
      }
    }
  };
}
