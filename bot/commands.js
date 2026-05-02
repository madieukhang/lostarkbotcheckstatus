import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import { getRaidChoices } from './models/Raid.js';

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show live server status')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Reset the stored status state back to default')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('roster')
      .setDescription('Fetch roster for a Lost Ark character with progression tracking')
      .setDMPermission(false)
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Character name to look up')
          .setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('deep')
          .setDescription('Run Stronghold alt detection scan (slower, finds hidden alts)')
          .setRequired(false)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('deep_limit')
          .setDescription('Stronghold scan limit: default env limit, 0 = scan all candidates')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(500)
      ),

    new SlashCommandBuilder()
      .setName('list')
      .setDescription('Manage blacklist/whitelist/watchlist entries')
      .setDMPermission(false)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a character to blacklist, whitelist, or watchlist')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Which list to add to')
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
              .setDescription('Character name to add')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Reason for this entry')
              .setRequired(true)
          )
          .addStringOption((opt) => {
            opt
              .setName('raid')
              .setDescription('Optional raid tag')
              .setRequired(false);

            for (const choice of getRaidChoices()) {
              opt.addChoices(choice);
            }

            return opt;
          })
          .addStringOption((opt) =>
            opt
              .setName('logs')
              .setDescription('Optional lostark.bible logs URL')
              .setRequired(false)
          )
          .addAttachmentOption((opt) =>
            opt
              .setName('image')
              .setDescription('Optional evidence screenshot')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('scope')
              .setDescription('Global (all servers) or Server (this server only) — blacklist only')
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
          .setDescription('Edit an existing list entry (reason, raid, type, scope)')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Character name to edit')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('New reason (leave empty to keep current)')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Move to a different list')
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
              .setDescription('New raid tag')
              .setRequired(false);

            for (const choice of getRaidChoices()) {
              opt.addChoices(choice);
            }

            return opt;
          })
          .addStringOption((opt) =>
            opt
              .setName('logs')
              .setDescription('New logs URL')
              .setRequired(false)
          )
          .addAttachmentOption((opt) =>
            opt
              .setName('image')
              .setDescription('New evidence screenshot')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('scope')
              .setDescription('Promote local→global or demote global→local — blacklist only')
              .setRequired(false)
              .addChoices(
                { name: 'global', value: 'global' },
                { name: 'server', value: 'server' }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a character from blacklist/whitelist/watchlist')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Character name to remove')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View all entries in a list')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Which list to view')
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
              .setDescription('Filter blacklist by scope (owner server only for "all servers")')
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
          .setDescription('Manage trusted list — trusted characters cannot be added to any list')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('Add or remove from trusted list')
              .setRequired(true)
              .addChoices(
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' }
              )
          )
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Character name')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('reason')
              .setDescription('Reason for trust (only for add)')
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('multiadd')
          .setDescription('Bulk add via Excel template — officers auto, members via Senior approval')
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('template = download blank template, file = upload filled template')
              .setRequired(true)
              .addChoices(
                { name: 'template — download blank template', value: 'template' },
                { name: 'file — upload filled template', value: 'file' }
              )
          )
          .addAttachmentOption((opt) =>
            opt
              .setName('file')
              .setDescription('Filled .xlsx file (max 30 rows, required for action:file)')
              .setRequired(false)
          )
      ),

    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search for a character name with filters and cross-check lists')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Character name to search')
          .setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('min_ilvl')
          .setDescription('Minimum item level (default: 1700)')
          .setRequired(false)
          .setMinValue(0)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('max_ilvl')
          .setDescription('Maximum item level')
          .setRequired(false)
      )
      .addStringOption((opt) => {
        return opt
          .setName('class')
          .setDescription('Filter by class')
          .setRequired(false)
          .setAutocomplete(true);
      })
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('listcheck')
      .setDescription('Check names from screenshot against all lists')
      .setDMPermission(false)
      .addAttachmentOption((opt) =>
        opt
          .setName('image')
          .setDescription('Raid waiting room screenshot')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('lahelp')
      .setDescription('Show all available Lost Ark bot commands')
      .setDMPermission(false)
      .addStringOption((opt) =>
        opt
          .setName('lang')
          .setDescription('Language (default: en)')
          .setRequired(false)
          .addChoices(
            { name: 'English', value: 'en' },
            { name: 'Tiếng Việt', value: 'vn' }
          )
      ),

    new SlashCommandBuilder()
      .setName('lasetup')
      .setDescription('Configure bot channels for this server')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('autochannel')
          .setDescription('Set the channel for auto-checking screenshots')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel where screenshots will be auto-checked')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('notifychannel')
          .setDescription('Set the channel for list add/remove notifications')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel where list notifications will be sent')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View current bot channel configuration')
      )
      .addSubcommand((sub) =>
        sub
          .setName('off')
          .setDescription('Toggle global list notifications on/off for this server')
      )
      .addSubcommand((sub) =>
        sub
          .setName('defaultscope')
          .setDescription('Set default blacklist scope for /list add (global or server)')
          .addStringOption((opt) =>
            opt
              .setName('scope')
              .setDescription('Default scope when /list add does not specify scope')
              .setRequired(true)
              .addChoices(
                { name: 'global', value: 'global' },
                { name: 'server', value: 'server' }
              )
          )
      )
      ,
  ].map((cmd) => cmd.toJSON());
}

/**
 * Owner-guild-only commands — registered as guild-specific, invisible to other servers.
 */
export function buildOwnerCommands() {
  return [
    new SlashCommandBuilder()
      .setName('lastats')
      .setDescription('Show bot usage statistics')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('laremote')
      .setDescription('Senior: view/control bot config for any server (silent)')
      .setDMPermission(false)
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('What to do')
          .setRequired(true)
          .addChoices(
            { name: 'view — show all servers + bot config', value: 'view' },
            { name: 'off — toggle notify for a server', value: 'off' },
            { name: 'defaultscope — set scope for a server', value: 'defaultscope' },
            { name: 'evidencechannel — set image rehost channel (bot-wide)', value: 'evidencechannel' },
            { name: 'syncimages — migrate legacy URLs to rehosted evidence', value: 'syncimages' }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName('guild')
          .setDescription('Target server ID (required for off/defaultscope)')
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('Scope value (for defaultscope action only)')
          .setRequired(false)
          .addChoices(
            { name: 'global', value: 'global' },
            { name: 'server', value: 'server' }
          )
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to use (required for evidencechannel action)')
          .setRequired(false)
      ),
  ].map((cmd) => cmd.toJSON());
}
