import { EmbedBuilder } from 'discord.js';

import { STATUS } from '../monitor/serverStatus.js';
import { COLORS, ICONS, relativeTime } from '../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../utils/alertEmbed.js';

const STATUS_GLYPH = Object.freeze({
  [STATUS.ONLINE]:      '🟢',
  [STATUS.OFFLINE]:     '🔴',
  [STATUS.MAINTENANCE]: '🟡',
});

function formatStatus(status) {
  switch (status) {
    case STATUS.ONLINE:      return `${STATUS_GLYPH[STATUS.ONLINE]} Online`;
    case STATUS.OFFLINE:     return `${STATUS_GLYPH[STATUS.OFFLINE]} Offline`;
    case STATUS.MAINTENANCE: return `${STATUS_GLYPH[STATUS.MAINTENANCE]} Maintenance`;
    default:                 return '❓ Unknown';
  }
}

export function createSystemHandlers({ checkStatus, resetState, client }) {
  async function handleStatusCommand(interaction) {
    await interaction.deferReply();

    try {
      const statusMap = await checkStatus(client);

      const allStatuses = [...statusMap.values()];
      const allOnline = allStatuses.every((s) => s === STATUS.ONLINE);
      const hasOffline = allStatuses.some((s) => s === STATUS.OFFLINE);
      const hasMaintenance = allStatuses.some((s) => s === STATUS.MAINTENANCE);

      // Headline summary at the top of the description so the overall
      // health reads at a glance without parsing the per-server fields.
      let headline;
      if (hasOffline) {
        headline = `${STATUS_GLYPH[STATUS.OFFLINE]} **Some servers are offline.** Check below for which.`;
      } else if (hasMaintenance) {
        headline = `${STATUS_GLYPH[STATUS.MAINTENANCE]} **Maintenance window in progress** for at least one server.`;
      } else if (allOnline) {
        headline = `${STATUS_GLYPH[STATUS.ONLINE]} **All monitored servers online.**`;
      } else {
        headline = '❓ **Mixed / unknown status.** Some servers did not report.';
      }

      const fields = [];
      for (const [server, status] of statusMap) {
        fields.push({ name: server, value: formatStatus(status), inline: true });
      }

      const color = hasOffline ? COLORS.danger : allOnline ? COLORS.success : COLORS.warning;

      const embed = new EmbedBuilder()
        .setAuthor({ name: 'Lost Ark · Server Status' })
        .setDescription(`${headline}\n\nChecked ${relativeTime(Date.now())}.`)
        .addFields(fields)
        .setColor(color)
        .setFooter({ text: `Source: playlostark.com · ${ICONS.refresh} re-run /la-status to refresh` })
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
