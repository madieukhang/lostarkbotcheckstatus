import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';

import {
  buildMultiaddTemplate,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiadd/index.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { t } from '../../../services/i18n/index.js';
import { listTypeIcon } from '../helpers.js';

export async function buildTemplateReply(lang = 'en') {
  const buffer = await buildMultiaddTemplate();
  const attachment = new AttachmentBuilder(buffer, {
    name: 'multiadd_template.xlsx',
    description: t('dialogue.multiadd.template.attachmentDescription', lang),
  });

  const templateEmbed = createArtistEmbed(lang)
    .setTitle(`📋 ${t('dialogue.multiadd.template.title', lang)}`)
    .setDescription(t('dialogue.multiadd.template.description', lang, { count: MULTIADD_MAX_ROWS }))
    .setColor(COLORS.info)
    .addFields(
      {
        name: `✅ ${t('dialogue.multiadd.template.required', lang)}`,
        value: '`name` · `type` · `reason`',
        inline: true,
      },
      {
        name: `🔹 ${t('dialogue.multiadd.template.optional', lang)}`,
        value: '`raid` · `logs` · `image` · `scope`',
        inline: true,
      },
      {
        name: `💡 ${t('dialogue.multiadd.template.tips', lang)}`,
        value: t('dialogue.multiadd.template.tipsValue', lang),
        inline: false,
      }
    )
    .setFooter({
      text: t('dialogue.multiadd.template.footer', lang, { count: MULTIADD_MAX_ROWS }),
    });

  return {
    embeds: [templateEmbed],
    files: [attachment],
  };
}

export function buildNoValidRowsEmbed(errors, lang = 'en') {
  return buildAlertEmbed({
    severity: AlertSeverity.ERROR,
    title: t('dialogue.multiadd.errors.noRows.title', lang),
    description: errors.length > 0
      ? errors.slice(0, 15).join('\n').slice(0, 4000)
      : t('dialogue.multiadd.errors.noRows.empty', lang),
    footer: t('dialogue.multiadd.errors.noRows.footer', lang),
    lang,
  });
}

export function buildPreviewReply(parsed, requestId, lang = 'en') {
  const previewLines = parsed.rows.slice(0, 20).map((row, index) => {
    const reasonShort = row.reason.length > 50 ? `${row.reason.slice(0, 47)}...` : row.reason;
    const scopeTag = row.scope === 'server' ? ' `[S]`' : '';
    return `\`${String(index + 1).padStart(2, ' ')}.\` ${listTypeIcon(row.type)} **${row.name}**${scopeTag} · ${reasonShort}`;
  });
  if (parsed.rows.length > 20) {
    previewLines.push(`*${t('dialogue.multiadd.preview.more', lang, { count: parsed.rows.length - 20 })}*`);
  }

  const rowWord = (count) => t(`dialogue.multiadd.preview.${count === 1 ? 'rowOne' : 'rowMany'}`, lang);
  const headerLine = parsed.errors.length > 0
    ? t('dialogue.multiadd.preview.withErrors', lang, {
        valid: parsed.rows.length,
        validWord: rowWord(parsed.rows.length),
        errors: parsed.errors.length,
        errorWord: t(`dialogue.multiadd.preview.${parsed.errors.length === 1 ? 'errorOne' : 'errorMany'}`, lang),
      })
    : t('dialogue.multiadd.preview.ready', lang, { count: parsed.rows.length, rowWord: rowWord(parsed.rows.length) });

  const previewEmbed = createArtistEmbed(lang)
    .setTitle(`📋 ${t('dialogue.multiadd.preview.title', lang, { count: parsed.rows.length, rowWord: rowWord(parsed.rows.length) })}`)
    .setDescription([headerLine, '', previewLines.join('\n')].join('\n').slice(0, 4096))
    .setColor(COLORS.info)
    .setFooter({ text: t('dialogue.multiadd.preview.sessionFooter', lang) })
    .setTimestamp();

  if (parsed.errors.length > 0) {
    const errText = parsed.errors.slice(0, 10).join('\n').slice(0, 1024);
    const suffix = parsed.errors.length > 10 ? `\n*${t('dialogue.multiadd.summary.more', lang, { count: parsed.errors.length - 10 })}*` : '';
    previewEmbed.addFields({
      name: `⚠️ ${t('dialogue.multiadd.preview.validationErrors', lang, { count: parsed.errors.length })}`,
      value: (errText + suffix).slice(0, 1024),
    });
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`multiadd_confirm:${requestId}`)
      .setLabel(t('common.actions.confirmAddCompact', lang, { count: parsed.rows.length }))
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`multiadd_cancel:${requestId}`)
      .setLabel(t('common.actions.cancel', lang))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️')
  );

  return {
    embeds: [previewEmbed],
    components: [confirmRow],
  };
}
