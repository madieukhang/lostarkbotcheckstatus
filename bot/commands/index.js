import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import { getRaidChoices } from '../models/Raid.js';
import { getSupportedLanguages, t } from '../services/i18n/index.js';

/**
 * Phase 4 (2026-05-03) put every bot command under the `la-` prefix so
 * Discord autocomplete groups all of them under `/la`. Each command
 * builder takes the slash command name; we call it once per command
 * with the `la-` name (e.g. `la-status`, `la-list`, `la-help`).
 *
 * Phase 4a registered both legacy + `la-` names as aliases; Phase 4c
 * (this commit) removed the legacy halves once the soft-deprecation
 * banner had been live long enough.
 */

function commandText(key) {
  return t(`commands.${key}`);
}

function statusCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('status.description'))
    .setDMPermission(false);
}

function resetCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('reset.description'))
    .setDMPermission(false);
}

function rosterCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('roster.description'))
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription(commandText('roster.options.name'))
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('deep')
        .setDescription(commandText('roster.options.deep'))
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('deep_limit')
        .setDescription(commandText('roster.options.deepLimit'))
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(500)
    );
}

function listCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('list.description'))
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription(commandText('list.subcommands.add.description'))
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription(commandText('list.subcommands.add.options.type'))
            .setRequired(true)
            .addChoices(
              { name: 'black', value: 'black' },
              { name: 'white', value: 'white' },
              { name: 'watch', value: 'watch' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription(commandText('list.subcommands.add.options.name'))
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription(commandText('list.subcommands.add.options.reason'))
            .setRequired(true)
        )
        .addStringOption((opt) => {
          opt
            .setName('raid')
            .setDescription(commandText('list.subcommands.add.options.raid'))
            .setRequired(false);

          for (const choice of getRaidChoices()) {
            opt.addChoices(choice);
          }

          return opt;
        })
        .addStringOption((opt) =>
          opt
            .setName('logs')
            .setDescription(commandText('list.subcommands.add.options.logs'))
            .setRequired(false)
        )
        .addAttachmentOption((opt) =>
          opt
            .setName('image')
            .setDescription(commandText('list.subcommands.add.options.image'))
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('scope')
            .setDescription(commandText('list.subcommands.add.options.scope'))
            .setRequired(false)
            .addChoices(
              { name: 'global', value: 'global' },
              { name: 'server', value: 'server' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription(commandText('list.subcommands.edit.description'))
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription(commandText('list.subcommands.edit.options.name'))
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription(commandText('list.subcommands.edit.options.reason'))
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription(commandText('list.subcommands.edit.options.type'))
            .setRequired(false)
            .addChoices(
              { name: 'black', value: 'black' },
              { name: 'white', value: 'white' },
              { name: 'watch', value: 'watch' }
            )
        )
        .addStringOption((opt) => {
          opt
            .setName('raid')
            .setDescription(commandText('list.subcommands.edit.options.raid'))
            .setRequired(false);

          for (const choice of getRaidChoices()) {
            opt.addChoices(choice);
          }

          return opt;
        })
        .addStringOption((opt) =>
          opt
            .setName('logs')
            .setDescription(commandText('list.subcommands.edit.options.logs'))
            .setRequired(false)
        )
        .addAttachmentOption((opt) =>
          opt
            .setName('image')
            .setDescription(commandText('list.subcommands.edit.options.image'))
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('scope')
            .setDescription(commandText('list.subcommands.edit.options.scope'))
            .setRequired(false)
            .addChoices(
              { name: 'global', value: 'global' },
              { name: 'server', value: 'server' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('additional_names')
            .setDescription(commandText('list.subcommands.edit.options.additionalNames'))
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription(commandText('list.subcommands.remove.description'))
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription(commandText('list.subcommands.remove.options.name'))
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription(commandText('list.subcommands.view.description'))
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription(commandText('list.subcommands.view.options.type'))
            .setRequired(true)
            .addChoices(
              { name: 'all', value: 'all' },
              { name: 'black', value: 'black' },
              { name: 'white', value: 'white' },
              { name: 'watch', value: 'watch' },
              { name: 'trusted', value: 'trusted' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('scope')
            .setDescription(commandText('list.subcommands.view.options.scope'))
            .setRequired(false)
            .addChoices(
              { name: 'all', value: 'all' },
              { name: 'global', value: 'global' },
              { name: 'server', value: 'server' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('trust')
        .setDescription(commandText('list.subcommands.trust.description'))
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription(commandText('list.subcommands.trust.options.action'))
            .setRequired(true)
            .addChoices(
              { name: 'add', value: 'add' },
              { name: 'remove', value: 'remove' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription(commandText('list.subcommands.trust.options.name'))
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription(commandText('list.subcommands.trust.options.reason'))
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('enrich')
        .setDescription(commandText('list.subcommands.enrich.description'))
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription(commandText('list.subcommands.enrich.options.name'))
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('deep_limit')
            .setDescription(commandText('list.subcommands.enrich.options.deepLimit'))
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(500)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('multiadd')
        .setDescription(commandText('list.subcommands.multiadd.description'))
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription(commandText('list.subcommands.multiadd.options.action'))
            .setRequired(true)
            .addChoices(
              { name: 'template - download blank template', value: 'template' },
              { name: 'file - upload filled template', value: 'file' }
            )
        )
        .addAttachmentOption((opt) =>
          opt
            .setName('file')
            .setDescription(commandText('list.subcommands.multiadd.options.file'))
            .setRequired(false)
        )
    );
}

function searchCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('search.description'))
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription(commandText('search.options.name'))
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('min_ilvl')
        .setDescription(commandText('search.options.minIlvl'))
        .setRequired(false)
        .setMinValue(0)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('max_ilvl')
        .setDescription(commandText('search.options.maxIlvl'))
        .setRequired(false)
    )
    .addStringOption((opt) => {
      return opt
        .setName('class')
        .setDescription(commandText('search.options.class'))
        .setRequired(false)
        .setAutocomplete(true);
    })
    .setDMPermission(false);
}

function evidenceCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('evidence.description'))
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription(commandText('evidence.options.name'))
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('public')
        .setDescription(commandText('evidence.options.public'))
        .setRequired(false)
    );
}

function listCheckCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('check.description'))
    .setDMPermission(false)
    .addAttachmentOption((opt) =>
      opt
        .setName('image')
        .setDescription(commandText('check.options.image'))
        .setRequired(true)
    );
}

function helpCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('help.description'))
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('lang')
        .setDescription(commandText('help.options.lang'))
        .setRequired(false)
        .addChoices(...getSupportedLanguages().map((language) => ({
          name: language.label,
          value: language.code,
        })))
    );
}

function languageSwitchCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('languageSwitch.description'))
    .setDMPermission(false);
}

function setupCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('setup.description'))
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('autochannel')
        .setDescription(commandText('setup.subcommands.autochannel.description'))
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription(commandText('setup.subcommands.autochannel.options.channel'))
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('notifychannel')
        .setDescription(commandText('setup.subcommands.notifychannel.description'))
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription(commandText('setup.subcommands.notifychannel.options.channel'))
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription(commandText('setup.subcommands.view.description'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription(commandText('setup.subcommands.off.description'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('defaultscope')
        .setDescription(commandText('setup.subcommands.defaultscope.description'))
        .addStringOption((opt) =>
          opt
            .setName('scope')
            .setDescription(commandText('setup.subcommands.defaultscope.options.scope'))
            .setRequired(true)
            .addChoices(
              { name: 'global', value: 'global' },
              { name: 'server', value: 'server' }
            )
        )
    );
}

function statsCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('stats.description'))
    .setDMPermission(false);
}

function remoteCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(commandText('remote.description'))
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName('action')
        .setDescription(commandText('remote.options.action'))
        .setRequired(true)
        .addChoices(
          { name: 'view - show all servers + bot config', value: 'view' },
          { name: 'off - toggle notify for a server', value: 'off' },
          { name: 'defaultscope - set scope for a server', value: 'defaultscope' },
          { name: 'evidencechannel - set image rehost channel (bot-wide)', value: 'evidencechannel' },
          { name: 'syncimages - migrate legacy URLs to rehosted evidence', value: 'syncimages' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('guild')
        .setDescription(commandText('remote.options.guild'))
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('scope')
        .setDescription(commandText('remote.options.scope'))
        .setRequired(false)
        .addChoices(
          { name: 'global', value: 'global' },
          { name: 'server', value: 'server' }
        )
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription(commandText('remote.options.channel'))
        .setRequired(false)
    );
}

const PUBLIC_COMMAND_DEFS = [
  ['la-status', statusCommand],
  ['la-reset', resetCommand],
  ['la-roster', rosterCommand],
  ['la-list', listCommand],
  ['la-search', searchCommand],
  ['la-evidence', evidenceCommand],
  ['la-check', listCheckCommand],
  ['la-help', helpCommand],
  ['la-language-switch', languageSwitchCommand],
  ['la-setup', setupCommand],
];

const OWNER_COMMAND_DEFS = [
  ['la-stats', statsCommand],
  ['la-remote', remoteCommand],
];

export function buildCommands() {
  return PUBLIC_COMMAND_DEFS.map(([name, builder]) => builder(name).toJSON());
}

/**
 * Owner-guild-only commands - registered as guild-specific, invisible to other servers.
 */
export function buildOwnerCommands() {
  return OWNER_COMMAND_DEFS.map(([name, builder]) => builder(name).toJSON());
}
