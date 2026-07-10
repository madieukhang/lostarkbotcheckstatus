import { createArtistEmbed } from '../../utils/artistVoice.js';

import { STATUS } from '../../monitor/serverStatus.js';
import { COLORS, ICONS, relativeTime } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../utils/interactionReplies.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';

const STATUS_GLYPH = Object.freeze({
  [STATUS.ONLINE]:      '🟢',
  [STATUS.OFFLINE]:     '🔴',
  [STATUS.MAINTENANCE]: '🟡',
});

function formatStatus(status, lang) {
  switch (status) {
    case STATUS.ONLINE:      return `${STATUS_GLYPH[STATUS.ONLINE]} ${t('dialogue.system.status.labels.online', lang)}`;
    case STATUS.OFFLINE:     return `${STATUS_GLYPH[STATUS.OFFLINE]} ${t('dialogue.system.status.labels.offline', lang)}`;
    case STATUS.MAINTENANCE: return `${STATUS_GLYPH[STATUS.MAINTENANCE]} ${t('dialogue.system.status.labels.maintenance', lang)}`;
    default:                 return `❓ ${t('dialogue.system.status.labels.unknown', lang)}`;
  }
}

export function createSystemHandlers({ checkStatus, resetState, client }) {
  async function handleStatusCommand(interaction) {
    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });

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
        headline = t('dialogue.system.status.headline.offline', lang, { count: offlineCount });
      } else if (maintenanceCount > 0) {
        headline = t('dialogue.system.status.headline.maintenance', lang, { count: maintenanceCount });
      } else if (allOnline) {
        headline = t('dialogue.system.status.headline.online', lang, { count: allStatuses.length });
      } else {
        headline = t('dialogue.system.status.headline.unknown', lang, { count: unknownCount });
      }

      const fields = [];

      // Stats summary badge as a single field row when the count is
      // worth surfacing (more than one bucket non-zero). Discord renders
      // 3 inline fields on one line which gives a quick visual grid
      // before the per-server detail block kicks in.
      const stats = [];
      if (onlineCount > 0) stats.push({ name: `🟢 ${t('dialogue.system.status.labels.online', lang)}`, value: String(onlineCount), inline: true });
      if (maintenanceCount > 0) stats.push({ name: `🟡 ${t('dialogue.system.status.labels.maintenance', lang)}`, value: String(maintenanceCount), inline: true });
      if (offlineCount > 0) stats.push({ name: `🔴 ${t('dialogue.system.status.labels.offline', lang)}`, value: String(offlineCount), inline: true });
      if (unknownCount > 0) stats.push({ name: `❓ ${t('dialogue.system.status.labels.unknown', lang)}`, value: String(unknownCount), inline: true });
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
        fields.push({ name: server, value: formatStatus(status, lang), inline: true });
      }

      const embed = createArtistEmbed(lang)
        .setTitle(`${titleIcon} ${t('dialogue.system.status.title', lang)}`)
        .setDescription(`${headline}\n\n${t('dialogue.system.status.checked', lang, { time: relativeTime(Date.now()) })}`)
        .addFields(fields)
        .setColor(color)
        .setFooter({ text: t('dialogue.system.status.footer', lang, { refresh: ICONS.refresh }) })
        .setTimestamp();

      await editEmbed(interaction, embed);
    } catch (err) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.system.status.failed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  async function handleResetCommand(interaction) {
    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });
    await resetState();
    await editAlert(interaction, {
      severity: AlertSeverity.SUCCESS,
      ...t('dialogue.system.reset', lang),
      lang,
    });
  }

  return {
    handleStatusCommand,
    handleResetCommand,
  };
}
