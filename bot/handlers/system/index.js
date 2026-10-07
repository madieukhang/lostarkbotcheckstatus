import { createArtistEmbed } from '../../utils/artistVoice.js';

import { connectDB } from '../../db.js';
import { STATUS } from '../../monitor/serverStatus.js';
import { COLORS, ICONS, relativeTime } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../utils/interactionReplies.js';
import { rejectNonSenior } from '../../utils/seniorGate.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';

const STATUS_GLYPH = Object.freeze({
  [STATUS.ONLINE]:      '🟢',
  [STATUS.OFFLINE]:     '🔴',
  [STATUS.MAINTENANCE]: '🟡',
});

const STATUS_LABEL_KEY = Object.freeze({
  [STATUS.ONLINE]:      'online',
  [STATUS.OFFLINE]:     'offline',
  [STATUS.MAINTENANCE]: 'maintenance',
});

/**
 * Localized word for a status, without the glyph. The per-server grid
 * puts the glyph on the field label instead, so the value stays a plain
 * token it can render as a badge.
 */
function statusLabel(status, lang) {
  return t(`dialogue.system.status.labels.${STATUS_LABEL_KEY[status] || 'unknown'}`, lang);
}

const SYSTEM_HEALTH_RULES = [
  {
    matches: ({ offlineCount }) => offlineCount > 0,
    state: 'offline',
    status: STATUS.OFFLINE,
    color: COLORS.danger,
    countKey: 'offlineCount',
  },
  {
    matches: ({ maintenanceCount }) => maintenanceCount > 0,
    state: 'maintenance',
    status: STATUS.MAINTENANCE,
    color: COLORS.warning,
    countKey: 'maintenanceCount',
  },
  {
    matches: ({ onlineCount, totalCount }) => onlineCount === totalCount && totalCount > 0,
    state: 'online',
    status: STATUS.ONLINE,
    color: COLORS.success,
    countKey: 'totalCount',
  },
  {
    matches: () => true,
    state: 'unknown',
    status: STATUS.UNKNOWN,
    color: COLORS.warning,
    countKey: 'unknownCount',
  },
];

export function resolveSystemHealth(counts) {
  const rule = SYSTEM_HEALTH_RULES.find(({ matches }) => matches(counts));
  return {
    state: rule.state,
    titleIcon: STATUS_GLYPH[rule.status] || '❓',
    color: rule.color,
    count: counts[rule.countKey],
  };
}

export function createSystemHandlers({ checkStatus, resetState, client, connectDBFn = connectDB }) {
  async function handleStatusCommand(interaction) {
    await deferReply(interaction);
    await connectDBFn();
    const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });

    try {
      const statusMap = await checkStatus(client);

      const allStatuses = [...statusMap.values()];
      const onlineCount = allStatuses.filter((s) => s === STATUS.ONLINE).length;
      const offlineCount = allStatuses.filter((s) => s === STATUS.OFFLINE).length;
      const maintenanceCount = allStatuses.filter((s) => s === STATUS.MAINTENANCE).length;
      const unknownCount = allStatuses.length - onlineCount - offlineCount - maintenanceCount;
      const health = resolveSystemHealth({
        onlineCount,
        offlineCount,
        maintenanceCount,
        unknownCount,
        totalCount: allStatuses.length,
      });

      // The shared classification keeps icon/color and headline priority
      // aligned: offline > maintenance > all-online > unknown.
      const headline = t(`dialogue.system.status.headline.${health.state}`, lang, {
        count: health.count,
      });

      // The headline already carries the count, so the fields list the
      // servers only, sorted so problem servers float to the top.
      const PRIORITY = { [STATUS.OFFLINE]: 0, [STATUS.MAINTENANCE]: 1, [STATUS.ONLINE]: 2 };
      const sortedServers = [...statusMap.entries()].sort((a, b) => {
        const pa = PRIORITY[a[1]] ?? 3;
        const pb = PRIORITY[b[1]] ?? 3;
        return pa - pb;
      });
      const fields = [];
      for (const [server, status] of sortedServers) {
        // The status glyph leads the label, as every other card in the
        // bot does · a bare server name was the one unlabelled field
        // left, and it put the icon on the value instead.
        fields.push({
          name: `${STATUS_GLYPH[status] || '❓'} ${server}`,
          value: `\`${statusLabel(status, lang)}\``,
          inline: true,
        });
      }

      const embed = createArtistEmbed()
        .setTitle(`${health.titleIcon} ${t('dialogue.system.status.title', lang)}`)
        .setDescription(`${headline}\n\n${t('dialogue.system.status.checked', lang, { time: relativeTime(Date.now()) })}`)
        .addFields(fields)
        .setColor(health.color)
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
    await connectDBFn();
    const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });
    // /la-reset wipes the shared monitor state.
    if (await rejectNonSenior(interaction, lang, 'dialogue.system.seniorOnly')) return;
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
