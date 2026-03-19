import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import { getRaidChoices } from '../models/Raid.js';

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show the current cached Brelshaza server status'),

    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Force an immediate server status check right now'),

    new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Reset the stored status state back to default'),

    new SlashCommandBuilder()
      .setName('roster')
      .setDescription('List the roster for a Lost Ark character')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Character name to look up (e.g. Lazy)')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('list')
      .setDescription('Manage black/white list entries')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a character (will include in roster checks) to black/white list')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('Which list to update')
              .setRequired(true)
              .addChoices(
                { name: 'black', value: 'black' },
                { name: 'white', value: 'white' }
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
              .setDescription('Optional raid tag for this entry')
              .setRequired(false);

            for (const choice of getRaidChoices()) {
              opt.addChoices(choice);
            }

            return opt;
          })
          .addAttachmentOption((opt) =>
            opt
              .setName('image')
              .setDescription('Optional screenshot image')
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a character from black/white list')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Character name to remove')
              .setRequired(true)
          )
      ),

    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search for a character name and cross-check blacklist/whitelist')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Character name to search (e.g. Megumi)')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('listcheck')
      .setDescription('Check multiple names against blacklist/whitelist')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addAttachmentOption((opt) =>
        opt
          .setName('image')
          .setDescription('Team screenshot for checking')
          .setRequired(true)
      ),
  ].map((cmd) => cmd.toJSON());
}
