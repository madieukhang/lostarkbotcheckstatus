import { EmbedBuilder } from 'discord.js';

import { STATUS } from '../../serverStatus.js';

function formatStatus(status) {
  switch (status) {
    case STATUS.ONLINE:
      return '🟢 Online';
    case STATUS.OFFLINE:
      return '🔴 Offline';
    case STATUS.MAINTENANCE:
      return '🟡 Maintenance';
    default:
      return '❓ Unknown';
  }
}

export function createSystemHandlers({ getState, checkStatus, resetState, client }) {
  async function handleStatusCommand(interaction) {
    await interaction.deferReply();

    const state = await getState();

    const embed = new EmbedBuilder()
      .setTitle('Server status – Server Status')
      .addFields(
        {
          name: 'Current Status',
          value: formatStatus(state.lastStatus),
          inline: true,
        },
        {
          name: 'Last Checked',
          value: state.lastCheckTime
            ? `<t:${Math.floor(new Date(state.lastCheckTime).getTime() / 1000)}:R>`
            : 'Never',
          inline: true,
        },
        {
          name: 'Last Alert Sent',
          value: state.lastAlertTime
            ? `<t:${Math.floor(new Date(state.lastAlertTime).getTime() / 1000)}:R>`
            : 'Never',
          inline: true,
        }
      )
      .setColor(
        state.lastStatus === STATUS.ONLINE
          ? 0x57f287
          : state.lastStatus === STATUS.MAINTENANCE
          ? 0xfee75c
          : 0xed4245
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async function handleCheckCommand(interaction) {
    await interaction.deferReply();

    try {
      const current = await checkStatus(client);
      const embed = new EmbedBuilder()
        .setTitle('Server status – Live Check')
        .setDescription(`Status right now: **${formatStatus(current)}**`)
        .setColor(
          current === STATUS.ONLINE
            ? 0x57f287
            : current === STATUS.MAINTENANCE
            ? 0xfee75c
            : 0xed4245
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Failed to fetch server status: \`${err.message}\``,
      });
    }
  }

  async function handleResetCommand(interaction) {
    await interaction.deferReply();
    await resetState();
    await interaction.editReply({
      content: '✅ State has been reset. The bot will start tracking from the next check.',
    });
  }

  return {
    handleStatusCommand,
    handleCheckCommand,
    handleResetCommand,
  };
}
