/**
 * handlers/list/services/bulk.js
 * Bulk multiadd executor + summary embed builder. Called from the
 * /la-list multiadd modal confirm path · iterates the parsed rows,
 * runs the same executeListAddToDatabase as a single add per row
 * (with rehost guarded), collects added / skipped / failed buckets,
 * and renders the rich summary card.
 */

import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import { getGuildConfig } from '../../../utils/scope.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { COLORS } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';
import { listTypeIcon } from '../helpers.js';
import { buildListMutationPayload } from './mutationFlow.js';

function buildBulkDetailField({ items = [], limit, formatLine, name, lang, tail = '' }) {
  if (items.length === 0) return null;
  const lines = items.slice(0, limit).map(formatLine).join('\n');
  const overflow = items.length > limit
    ? `\n*${t('dialogue.multiadd.summary.more', lang, { count: items.length - limit })}*`
    : '';
  return {
    name,
    value: `${lines}${overflow}${tail}`.slice(0, 1024),
  };
}

/**
 * Build the bulk service bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {Function} deps.executeListAddToDatabase - per-row executor
 *   (reused from the single-add path so bulk obeys all the same dupe
 *   checks, trusted-block guards, and scope semantics).
 * @returns {{
 *   executeBulkMultiadd: Function,
 *   buildBulkSummaryEmbed: Function,
 * }}
 */
export function createBulkServices({ client, executeListAddToDatabase }) {
  async function resolveGuildDefaultScope(guildId) {
    try {
      await connectDB();
      const guildConfig = await getGuildConfig(guildId);
      return guildConfig?.defaultBlacklistScope || 'global';
    } catch (err) {
      console.warn('[multiadd] Failed to resolve guild default scope:', err.message);
      return 'global';
    }
  }

  async function resolveBulkRowImage(row, meta, results) {
    if (row.imageMessageId && row.imageChannelId) {
      return { messageId: row.imageMessageId, channelId: row.imageChannelId, freshUrl: '' };
    }
    if (!row.image) return null;
    try {
      return await rehostImage(row.image, client, {
        entryName: row.name,
        addedBy: meta.requesterDisplayName || meta.requesterTag,
        listType: row.type,
        throwOnError: true,
      });
    } catch (err) {
      results.rehostWarnings.push({ name: row.name, error: err.message });
      console.warn(`[multiadd] Row "${row.name}" image rehost failed:`, err.message);
      return null;
    }
  }

  function buildBulkRowPayload(row, meta, scope, rehost) {
    return buildListMutationPayload({
      guildId: meta.guildId,
      channelId: meta.channelId,
      requester: {
        id: meta.requesterId,
        tag: meta.requesterTag || '',
        username: meta.requesterName || '',
      },
      requestedByDisplayName: meta.requesterDisplayName || '',
      type: row.type,
      name: row.name,
      reason: row.reason,
      raid: row.raid || '',
      logsUrl: row.logs || '',
      imageUrl: rehost?.freshUrl || row.image || '',
      imageMessageId: rehost?.messageId || '',
      imageChannelId: rehost?.channelId || '',
      scope,
      skipBroadcast: true,
    });
  }

  function recordBulkRowResult(results, row, scope, result) {
    if (result.ok) {
      results.added.push({ name: row.name, type: row.type, scope, entry: result.entry });
      return;
    }
    if (result.isDuplicate) {
      results.skipped.push({ name: row.name, reason: 'duplicate (already in list)' });
      return;
    }
    const firstLine = (result.content || 'unknown error').split('\n')[0];
    const reason = firstLine.replace(/\*\*/g, '').replace(/[⚠️❌🛡️⛔✅]/g, '').trim();
    results.skipped.push({ name: row.name, reason: reason.slice(0, 80) });
  }

  async function executeBulkRow(row, meta, defaultScope, results) {
    const scope = row.type === 'black' ? (row.scope || defaultScope) : 'global';
    const rehost = await resolveBulkRowImage(row, meta, results);
    const payload = buildBulkRowPayload(row, meta, scope, rehost);
    try {
      const result = await executeListAddToDatabase(payload);
      recordBulkRowResult(results, row, scope, result);
    } catch (err) {
      console.error(`[multiadd] Row ${row.rowNum} "${row.name}" failed:`, err);
      results.failed.push({ name: row.name, error: err.message || 'unknown error' });
    }
  }

  async function reportBulkProgress(onProgress, completed, total) {
    if (!onProgress) return;
    try {
      await onProgress(completed, total);
    } catch { /* progress errors should not stop the batch */ }
  }

  async function executeBulkMultiadd(rows, meta, onProgress = null) {
    const results = { added: [], skipped: [], failed: [], rehostWarnings: [] };
    const guildDefaultScope = await resolveGuildDefaultScope(meta.guildId);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await executeBulkRow(row, meta, guildDefaultScope, results);
      await reportBulkProgress(onProgress, i + 1, rows.length);
      if (i < rows.length - 1) await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return results;
  }

  function buildBulkSummaryEmbed(results, meta, lang = 'en') {
    const totalAttempted = results.added.length + results.skipped.length + results.failed.length;
    const hasFailures = results.failed.length > 0;
    const color = hasFailures ? COLORS.warning : results.added.length > 0 ? COLORS.success : COLORS.danger;
    const successRate = totalAttempted > 0
      ? Math.round((results.added.length / totalAttempted) * 100)
      : 0;

    // Headline summary tells the operator the outcome at a glance:
    // "12 of 15 added (80%)". Per-list-type breakdown stays in the
    // Added/Skipped/Failed fields below.
    const headline = totalAttempted === 0
      ? t('dialogue.multiadd.summary.none', lang)
      : t('dialogue.multiadd.summary.headline', lang, { added: results.added.length, total: totalAttempted, rate: successRate });

    // Same card anatomy as the /la-list add result: counts ride the title,
    // the headline restates them in plain English, and the per-outcome
    // fields below carry the detail. The old bare-number Added/Skipped/
    // Failed 3-up was dropped · each detail field's header already shows
    // its count, so the 3-up said the same thing twice.
    const embed = createArtistEmbed(lang)
      .setTitle(`📋 ${t('dialogue.multiadd.summary.title', lang, { added: results.added.length, total: totalAttempted })}`)
      .setDescription(headline)
      .setColor(color)
      .setFooter({ text: t('dialogue.multiadd.summary.footer', lang, { user: meta.requesterDisplayName || t('dialogue.common.unknown', lang) }) })
      .setTimestamp(new Date());

    const detailFields = [
      buildBulkDetailField({
        items: results.added,
        limit: 15,
        formatLine: (row, index) => `${index + 1}. ${listTypeIcon(row.type)} **${row.name}**`,
        name: `✅ ${t('dialogue.multiadd.summary.added', lang, { count: results.added.length })}`,
        lang,
      }),
      buildBulkDetailField({
        items: results.skipped,
        limit: 10,
        formatLine: (row) => `• **${row.name}** · ${row.reason}`,
        name: `⚠️ ${t('dialogue.multiadd.summary.skipped', lang, { count: results.skipped.length })}`,
        lang,
      }),
      buildBulkDetailField({
        items: results.failed,
        limit: 10,
        formatLine: (row) => `• **${row.name}** · ${row.error}`,
        name: `❌ ${t('dialogue.multiadd.summary.failed', lang, { count: results.failed.length })}`,
        lang,
      }),
      buildBulkDetailField({
        items: results.rehostWarnings,
        limit: 10,
        formatLine: (row) => `• **${row.name}** · ${row.error}`,
        name: `🖼️ ${t('dialogue.multiadd.summary.imageFailed', lang, { count: results.rehostWarnings?.length || 0 })}`,
        lang,
        tail: `\n*${t('dialogue.multiadd.summary.imageLegacy', lang)}*`,
      }),
    ].filter(Boolean);
    embed.addFields(detailFields);

    return embed;
  }

  return {
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  };
}
