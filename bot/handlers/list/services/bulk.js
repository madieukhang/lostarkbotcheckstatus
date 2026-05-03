import { randomUUID } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import { getGuildConfig } from '../../../utils/scope.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { COLORS } from '../../../utils/ui.js';

export function createBulkServices({ client, executeListAddToDatabase }) {
  async function executeBulkMultiadd(rows, meta, onProgress = null) {
    const results = { added: [], skipped: [], failed: [], rehostWarnings: [] };

    let guildDefaultScope = 'global';
    try {
      await connectDB();
      const gc = await getGuildConfig(meta.guildId);
      guildDefaultScope = gc?.defaultBlacklistScope || 'global';
    } catch (err) {
      console.warn('[multiadd] Failed to resolve guild default scope:', err.message);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const effectiveScope =
        row.type === 'black' ? (row.scope || guildDefaultScope) : 'global';

      let rowRehost = null;
      if (row.imageMessageId && row.imageChannelId) {
        rowRehost = {
          messageId: row.imageMessageId,
          channelId: row.imageChannelId,
          freshUrl: '',
        };
      } else if (row.image) {
        try {
          rowRehost = await rehostImage(row.image, client, {
            entryName: row.name,
            addedBy: meta.requesterDisplayName || meta.requesterTag,
            listType: row.type,
            throwOnError: true,
          });
        } catch (rehostErr) {
          results.rehostWarnings.push({
            name: row.name,
            error: rehostErr.message,
          });
          console.warn(`[multiadd] Row "${row.name}" image rehost failed:`, rehostErr.message);
        }
      }

      const payload = {
        requestId: randomUUID(),
        guildId: meta.guildId,
        channelId: meta.channelId,
        type: row.type,
        name: row.name,
        reason: row.reason,
        raid: row.raid || '',
        logsUrl: row.logs || '',
        imageUrl: rowRehost?.freshUrl || row.image || '',
        imageMessageId: rowRehost?.messageId || '',
        imageChannelId: rowRehost?.channelId || '',
        scope: effectiveScope,
        requestedByUserId: meta.requesterId,
        requestedByTag: meta.requesterTag || '',
        requestedByName: meta.requesterName || '',
        requestedByDisplayName: meta.requesterDisplayName || '',
        createdAt: Date.now(),
        skipBroadcast: true,
      };

      try {
        const result = await executeListAddToDatabase(payload);
        if (result.ok) {
          results.added.push({
            name: row.name,
            type: row.type,
            scope: effectiveScope,
            entry: result.entry,
          });
        } else if (result.isDuplicate) {
          results.skipped.push({
            name: row.name,
            reason: 'duplicate (already in list)',
          });
        } else {
          const firstLine = (result.content || 'unknown error').split('\n')[0];
          const plain = firstLine.replace(/\*\*/g, '').replace(/[⚠️❌🛡️⛔✅]/g, '').trim();
          results.skipped.push({
            name: row.name,
            reason: plain.slice(0, 80),
          });
        }
      } catch (err) {
        console.error(`[multiadd] Row ${row.rowNum} "${row.name}" failed:`, err);
        results.failed.push({
          name: row.name,
          error: err.message || 'unknown error',
        });
      }

      if (onProgress) {
        try {
          await onProgress(i + 1, rows.length);
        } catch { /* progress errors should not stop the batch */ }
      }

      if (i < rows.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    return results;
  }

  function buildBulkSummaryEmbed(results, meta) {
    const totalAttempted = results.added.length + results.skipped.length + results.failed.length;
    const hasFailures = results.failed.length > 0;
    const color = hasFailures ? COLORS.warning : results.added.length > 0 ? COLORS.success : COLORS.danger;

    const embed = new EmbedBuilder()
      .setTitle('📋 Bulk Add Complete')
      .setDescription(`Processed **${totalAttempted}** row${totalAttempted === 1 ? '' : 's'}`)
      .setColor(color)
      .addFields(
        { name: '✅ Added', value: String(results.added.length), inline: true },
        { name: '⚠️ Skipped', value: String(results.skipped.length), inline: true },
        { name: '❌ Failed', value: String(results.failed.length), inline: true },
      )
      .setFooter({ text: `By ${meta.requesterDisplayName || 'Unknown'}` })
      .setTimestamp(new Date());

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');

    if (results.added.length > 0) {
      const addedLines = results.added
        .slice(0, 15)
        .map((r, i) => `${i + 1}. ${typeIcon(r.type)} **${r.name}**`)
        .join('\n');
      const suffix = results.added.length > 15 ? `\n*... and ${results.added.length - 15} more*` : '';
      embed.addFields({
        name: `Added (${results.added.length})`,
        value: (addedLines + suffix).slice(0, 1024),
      });
    }

    if (results.skipped.length > 0) {
      const skippedLines = results.skipped
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.reason}`)
        .join('\n');
      const suffix = results.skipped.length > 10 ? `\n*... and ${results.skipped.length - 10} more*` : '';
      embed.addFields({
        name: `Skipped (${results.skipped.length})`,
        value: (skippedLines + suffix).slice(0, 1024),
      });
    }

    if (results.failed.length > 0) {
      const failedLines = results.failed
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.error}`)
        .join('\n');
      const suffix = results.failed.length > 10 ? `\n*... and ${results.failed.length - 10} more*` : '';
      embed.addFields({
        name: `Failed (${results.failed.length})`,
        value: (failedLines + suffix).slice(0, 1024),
      });
    }

    if (results.rehostWarnings?.length > 0) {
      const warnLines = results.rehostWarnings
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.error}`)
        .join('\n');
      const suffix = results.rehostWarnings.length > 10
        ? `\n*... and ${results.rehostWarnings.length - 10} more*`
        : '';
      embed.addFields({
        name: `🖼️ Image rehost failed (${results.rehostWarnings.length})`,
        value: (
          warnLines + suffix +
          '\n*Entries added OK but images stored as legacy URLs — will expire in ~24h.*'
        ).slice(0, 1024),
      });
    }

    return embed;
  }

  return {
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  };
}
