import { EmbedBuilder } from 'discord.js';

import { STATUS } from '../../monitor/serverStatus.js';
import { COLORS, ICONS, relativeTime } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../utils/interactionReplies.js';

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
    await deferReply(interaction);

    try {
      const statusMap = await checkStatus(client);

      const allStatuses = [...statusMap.values()];
      const onlineCount = allStatuses.filter((s) => s === STATUS.ONLINE).length;
      const offlineCount = allStatuses.filter((s) => s === STATUS.OFFLINE).length;
      const maintenanceCount = allStatuses.filter((s) => s === STATUS.MAINTENANCE).length;
      const unknownCount = allStatuses.length - onlineCount - offlineCount - maintenanceCount;
      const allOnline = onlineCount === allStatuses.length && allStatuses.length > 0;

      // Title icon doubles as the at-a-glance health indicator: red dot
      // when anything is offline, yellow when maintenance is active,
      // green when all clear, question mark when servers haven't reported.
      let titleIcon;
      let color;
      if (offlineCount > 0) { titleIcon = '🔴'; color = COLORS.danger; }
      else if (maintenanceCount > 0) { titleIcon = '🟡'; color = COLORS.warning; }
      else if (allOnline) { titleIcon = '🟢'; color = COLORS.success; }
      else { titleIcon = '❓'; color = COLORS.warning; }

      // Headline summary at the top of the description gives the
      // reader the punchline before the per-server breakdown.
      let headline;
      if (offlineCount > 0) {
        headline = `**${offlineCount}** server(s) are offline.`;
      } else if (maintenanceCount > 0) {
        headline = `Maintenance window in progress for **${maintenanceCount}** server(s).`;
      } else if (allOnline) {
        headline = `All **${allStatuses.length}** monitored servers online.`;
      } else {
        headline = `Some servers did not report. **${unknownCount}** unknown.`;
      }

      const fields = [];

      // Stats summary badge as a single field row when the count is
      // worth surfacing (more than one bucket non-zero). Discord renders
      // 3 inline fields on one line which gives a quick visual grid
      // before the per-server detail block kicks in.
      const stats = [];
      if (onlineCount > 0) stats.push({ name: '🟢 Online', value: String(onlineCount), inline: true });
      if (maintenanceCount > 0) stats.push({ name: '🟡 Maintenance', value: String(maintenanceCount), inline: true });
      if (offlineCount > 0) stats.push({ name: '🔴 Offline', value: String(offlineCount), inline: true });
      if (unknownCount > 0) stats.push({ name: '❓ Unknown', value: String(unknownCount), inline: true });
      fields.push(...stats);

      // Per-server status grid follows. Sorted by status priority so
      // problem servers float to the top of the field list.
      const PRIORITY = { [STATUS.OFFLINE]: 0, [STATUS.MAINTENANCE]: 1, [STATUS.ONLINE]: 2 };
      const sortedServers = [...statusMap.entries()].sort((a, b) => {
        const pa = PRIORITY[a[1]] ?? 3;
        const pb = PRIORITY[b[1]] ?? 3;
        return pa - pb;
      });
      for (const [server, status] of sortedServers) {
        fields.push({ name: server, value: formatStatus(status), inline: true });
      }

      const embed = new EmbedBuilder()
        .setTitle(`${titleIcon} Lost Ark · Server Status`)
        .setDescription(`${headline}\n\nChecked ${relativeTime(Date.now())}.`)
        .addFields(fields)
        .setColor(color)
        .setFooter({ text: `Source: playlostark.com · ${ICONS.refresh} re-run /la-status to refresh` })
        .setTimestamp();

      await editEmbed(interaction, embed);
    } catch (err) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Status Fetch Failed',
        description: 'Could not fetch server status.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  async function handleResetCommand(interaction) {
    await deferReply(interaction);
    await resetState();
    await editAlert(interaction, {
      severity: AlertSeverity.SUCCESS,
      title: 'State Reset',
      description: 'The stored server status was cleared. The bot will start tracking from the next monitor cycle.',
    });
  }

  return {
    handleStatusCommand,
    handleResetCommand,
  };
}
