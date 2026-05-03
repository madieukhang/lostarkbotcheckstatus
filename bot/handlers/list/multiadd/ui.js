import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import {
  buildMultiaddTemplate,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiaddTemplateService.js';
import { COLORS } from '../../../utils/ui.js';

export async function buildTemplateReply() {
  const buffer = await buildMultiaddTemplate();
  const attachment = new AttachmentBuilder(buffer, {
    name: 'multiadd_template.xlsx',
    description: 'Lost Ark Bot · bulk add template',
  });

  const templateEmbed = new EmbedBuilder()
    .setTitle('📋 Bulk Add Template')
    .setDescription(
      `Fill in up to **${MULTIADD_MAX_ROWS} rows**, then upload via:\n` +
        '`/la-list multiadd action:file file:<your.xlsx>`'
    )
    .setColor(COLORS.info)
    .addFields(
      {
        name: '✅ Required Columns',
        value: '`name` · `type` · `reason`',
        inline: true,
      },
      {
        name: '🔹 Optional Columns',
        value: '`raid` · `logs` · `image` · `scope`',
        inline: true,
      },
      {
        name: '💡 Tips',
        value: [
          '• Use the **dropdown** in the `type` and `scope` columns.',
          '• Delete the yellow **example row** before uploading.',
          '• See the *Instructions* sheet inside the file for full details.',
          '• Upload evidence images to Discord first, then paste the link.',
        ].join('\n'),
        inline: false,
      }
    )
    .setFooter({
      text: `Lost Ark Bot • Max ${MULTIADD_MAX_ROWS} rows • 1 MB file limit`,
    });

  return {
    embeds: [templateEmbed],
    files: [attachment],
  };
}

export function buildNoValidRowsEmbed(errors) {
  return new EmbedBuilder()
    .setTitle('❌ No Valid Rows Found')
    .setDescription(
      errors.length > 0
        ? errors.slice(0, 15).join('\n').slice(0, 4000)
        : 'The file appears to be empty or has no data rows.'
    )
    .setColor(COLORS.danger)
    .setFooter({ text: 'Fix the errors and re-upload.' });
}

function typeIcon(type) {
  if (type === 'black') return '⛔';
  if (type === 'white') return '✅';
  return '⚠️';
}

export function buildPreviewReply(parsed, requestId) {
  const previewLines = parsed.rows.slice(0, 20).map((row, index) => {
    const reasonShort = row.reason.length > 50 ? `${row.reason.slice(0, 47)}...` : row.reason;
    const scopeTag = row.scope === 'server' ? ' `[S]`' : '';
    return `\`${String(index + 1).padStart(2, ' ')}.\` ${typeIcon(row.type)} **${row.name}**${scopeTag} · ${reasonShort}`;
  });
  if (parsed.rows.length > 20) {
    previewLines.push(`*... and ${parsed.rows.length - 20} more rows*`);
  }

  const previewEmbed = new EmbedBuilder()
    .setTitle(`📋 Bulk Add Preview · ${parsed.rows.length} valid row${parsed.rows.length === 1 ? '' : 's'}`)
    .setDescription(previewLines.join('\n').slice(0, 4000))
    .setColor(COLORS.info)
    .setFooter({
      text:
        parsed.errors.length > 0
          ? `${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'} below. Expires in 5 minutes.`
          : 'Expires in 5 minutes.',
    })
    .setTimestamp();

  if (parsed.errors.length > 0) {
    const errText = parsed.errors.slice(0, 10).join('\n').slice(0, 1024);
    const suffix = parsed.errors.length > 10 ? `\n*... and ${parsed.errors.length - 10} more*` : '';
    previewEmbed.addFields({
      name: `⚠️ Validation Errors (${parsed.errors.length})`,
      value: (errText + suffix).slice(0, 1024),
    });
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`multiadd_confirm:${requestId}`)
      .setLabel(`Confirm · Add ${parsed.rows.length}`)
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`multiadd_cancel:${requestId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️')
  );

  return {
    embeds: [previewEmbed],
    components: [confirmRow],
  };
}
