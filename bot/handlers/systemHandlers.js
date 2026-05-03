import { EmbedBuilder } from 'discord.js';

import { STATUS } from '../monitor/serverStatus.js';
import { COLORS } from '../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../utils/alertEmbed.js';

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

export function createSystemHandlers({ checkStatus, resetState, client }) {
  async function handleStatusCommand(interaction) {
    await interaction.deferReply();

    try {
      const statusMap = await checkStatus(client);

      const fields = [];
      for (const [server, status] of statusMap) {
        fields.push({ name: server, value: formatStatus(status), inline: true });
      }

      const allOnline = [...statusMap.values()].every((s) => s === STATUS.ONLINE);
      const hasOffline = [...statusMap.values()].some((s) => s === STATUS.OFFLINE);
      const color = hasOffline ? COLORS.danger : allOnline ? COLORS.success : COLORS.warning;

      const embed = new EmbedBuilder()
        .setTitle('Server Status')
        .addFields(fields)
        .setColor(color)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Status Fetch Failed',
          description: 'Could not fetch server status.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
      });
    }
  }

  async function handleResetCommand(interaction) {
    await interaction.deferReply();
    await resetState();
    await interaction.editReply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.SUCCESS,
        title: 'State Reset',
        description: 'The stored server status was cleared. The bot will start tracking from the next monitor cycle.',
      })],
    });
  }

  return {
    handleStatusCommand,
    handleResetCommand,
  };
}
