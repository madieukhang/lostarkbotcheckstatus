import { EmbedBuilder } from 'discord.js';

import config from '../../config.js';
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

function getStatusColor(status) {
  if (status === STATUS.ONLINE) return 0x57f287;
  if (status === STATUS.MAINTENANCE) return 0xfee75c;
  return 0xed4245;
}

export function createSystemHandlers({ getState, checkStatus, resetState, client }) {
  async function handleStatusCommand(interaction) {
    await interaction.deferReply();

    const state = await getState();
    const servers = state.servers || {};
    const serverNames = config.targetServers;

    const fields = [];

    for (const server of serverNames) {
      const s = servers[server];
      fields.push({
        name: server,
        value: formatStatus(s?.lastStatus ?? null),
        inline: true,
      });
    }

    fields.push(
      {
        name: 'Last Checked',
        value: state.lastCheckTime
          ? `<t:${Math.floor(new Date(state.lastCheckTime).getTime() / 1000)}:R>`
          : 'Never',
        inline: true,
      }
    );

    // Color based on worst status across all servers
    const allStatuses = serverNames.map((s) => servers[s]?.lastStatus);
    const hasOffline = allStatuses.some((s) => s === STATUS.OFFLINE);
    const hasMaintenance = allStatuses.some((s) => s === STATUS.MAINTENANCE);
    const color = hasOffline ? 0xed4245 : hasMaintenance ? 0xfee75c : 0x57f287;

    const embed = new EmbedBuilder()
      .setTitle('Server Status')
      .addFields(fields)
      .setColor(color)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  async function handleCheckCommand(interaction) {
    await interaction.deferReply();

    try {
      const statusMap = await checkStatus(client);

      const lines = [];
      for (const [server, status] of statusMap) {
        lines.push(`**${server}**: ${formatStatus(status)}`);
      }

      const allOnline = [...statusMap.values()].every((s) => s === STATUS.ONLINE);
      const hasOffline = [...statusMap.values()].some((s) => s === STATUS.OFFLINE);
      const color = hasOffline ? 0xed4245 : allOnline ? 0x57f287 : 0xfee75c;

      const embed = new EmbedBuilder()
        .setTitle('Server Status – Live Check')
        .setDescription(lines.join('\n'))
        .setColor(color)
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
