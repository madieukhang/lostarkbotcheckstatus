import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import { getRaidChoices } from '../models/Raid.js';
import { CLASS_NAMES } from '../models/Class.js';

/** Build class choices for slash command (unique display names only) */
function getClassChoices() {
  const seen = new Set();
  const choices = [];
  for (const [id, name] of Object.entries(CLASS_NAMES)) {
    if (seen.has(name)) continue;
    seen.add(name);
    choices.push({ name, value: id });
  }
  // Discord limit: 25 choices max
  return choices.slice(0, 25);
}

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show live server status'),

    new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Reset the stored status state back to default'),

    new SlashCommandBuilder()
      .setName('roster')
      .setDescription('Fetch roster for a Lost Ark character with progression tracking')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Character name to look up')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('list')
      .setDescription('Manage blacklist/whitelist/watchlist entries')
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
                { name: 'watch', value: 'watch' }
              )
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
        opt
          .setName('class')
          .setDescription('Filter by class')
          .setRequired(false);

        for (const choice of getClassChoices()) {
          opt.addChoices(choice);
        }

        return opt;
      }),

    new SlashCommandBuilder()
      .setName('listcheck')
      .setDescription('Check names from screenshot against all lists')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addAttachmentOption((opt) =>
        opt
          .setName('image')
          .setDescription('Raid waiting room screenshot')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show all available commands'),
  ].map((cmd) => cmd.toJSON());
}
