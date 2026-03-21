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
      const color = hasOffline ? 0xed4245 : allOnline ? 0x57f287 : 0xfee75c;

      const embed = new EmbedBuilder()
        .setTitle('Server Status')
        .addFields(fields)
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
    handleResetCommand,
  };
}
