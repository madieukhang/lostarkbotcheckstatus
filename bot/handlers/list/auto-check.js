/**
 * handlers/list/auto-check.js
 * Listens for image attachments or explicit `check <name>` messages in
 * designated channels and runs the shared blacklist/whitelist/watchlist check.
 *
 * Channel resolution (per message):
 *   1. Check GuildConfig in DB for this guild's autoCheckChannelId
 *   2. Fallback to AUTO_CHECK_CHANNEL_IDS env var (global)
 */

import { ActionRowBuilder, Events, StringSelectMenuBuilder } from 'discord.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../services/list-check/service.js';
import { getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { buildListCheckEmbed } from '../../utils/listCheckEmbed.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { getGuildLanguage, t } from '../../services/i18n/index.js';
import { buildAutoCheckEvidenceRow } from './check/index.js';

/** Env-based channel set (global fallback) */
const envChannelSet = new Set(config.autoCheckChannelIds);

/** Per-user cooldown to prevent spam (userId → timestamp) */
const userCooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10 seconds between checks per user
const processedMessages = new Map(); // messageId -> timestamp
const inFlightMessages = new Set();
const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
export const AUTO_CHECK_MAX_NAMES = 8;
const TEXT_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N}]{1,19}$/u;

/**
 * Parse an explicit auto-check text request. Bare names and words such as
 * `checkmate` are intentionally ignored so ordinary channel chatter cannot
 * trigger list checks.
 * @param {string} content
 * @returns {null|{names: string[], invalidTokens: string[]}}
 */
export function parseAutoCheckText(content) {
  const raw = String(content || '').trim();
  if (!/^check(?=$|[\s:])/iu.test(raw)) return null;

  const payload = raw.slice('check'.length).replace(/^\s*:\s*/u, '').trim();
  if (!payload) return { names: [], invalidTokens: [] };

  const tokens = payload.split(/[\s,;]+/u).filter(Boolean);
  const names = [];
  const invalidTokens = [];
  const seen = new Set();

  for (const token of tokens) {
    if (!TEXT_NAME_RE.test(token)) {
      invalidTokens.push(token);
      continue;
    }
    const name = normalizeCharacterName(token);
    const key = name.toLocaleLowerCase('en');
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return { names, invalidTokens };
}

function pruneProcessedMessages(now = Date.now()) {
  for (const [messageId, ts] of processedMessages) {
    if (now - ts > MESSAGE_DEDUPE_TTL_MS) {
      processedMessages.delete(messageId);
    }
  }
}

/**
 * Reserve a message for auto-check processing. Returns true when the
 * caller has exclusive ownership and should proceed, false when the
 * message is already in flight or has been processed within the TTL
 * window. Discord can deliver MessageCreate twice (gateway retries +
 * duplicate listeners in dev); this guard prevents duplicate OCR/text checks
 * for the same source message.
 * @param {string} messageId - Discord message snowflake
 * @param {number} [now=Date.now()] - timestamp override for tests
 * @returns {boolean} true if claimed, false if already claimed/processed
 */
export function claimAutoCheckMessage(messageId, now = Date.now()) {
  if (!messageId) return true;
  pruneProcessedMessages(now);
  if (inFlightMessages.has(messageId) || processedMessages.has(messageId)) {
    return false;
  }
  inFlightMessages.add(messageId);
  return true;
}

/**
 * Release a previously claimed message. Pass `processed: false` for
 * early-exit paths (image-less, off-channel, no OCR names) so the
 * message can be re-claimed if it arrives again instead of being
 * locked out for the dedupe TTL.
 * @param {string} messageId - Discord message snowflake claimed earlier
 * @param {object} [options]
 * @param {boolean} [options.processed=true] - mark as processed (default true)
 * @param {number} [options.now=Date.now()] - timestamp override for tests
 * @returns {void}
 */
export function completeAutoCheckMessage(messageId, options = {}) {
  if (!messageId) return;
  const { processed = true, now = Date.now() } = options;
  inFlightMessages.delete(messageId);
  if (processed) {
    processedMessages.set(messageId, now);
  }
}

/**
 * Wipe in-memory dedupe + cooldown state. Test seam only · lets each
 * test run start from a clean slate without restarting the module.
 * @returns {void}
 */
export function resetAutoCheckDedupeForTest() {
  processedMessages.clear();
  inFlightMessages.clear();
  userCooldowns.clear();
}

export function isQuickAddCandidate(result) {
  return !result.blackEntry && !result.whiteEntry && !result.watchEntry && !result.trustedEntry;
}

/**
 * Check if a channel is configured for auto-check
 * (either via DB GuildConfig or env var fallback).
 * @param {string} channelId
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
async function isAutoCheckChannel(channelId, guildId) {
  // DB config takes priority for this guild
  if (guildId) {
    try {
      const guildConfig = await getGuildConfig(guildId);
      if (guildConfig?.autoCheckChannelId) {
        return guildConfig.autoCheckChannelId === channelId;
      }
    } catch (err) {
      console.warn('[auto-check] Failed to query GuildConfig:', err.message);
    }
  }

  // Fallback to env var
  return envChannelSet.has(channelId);
}

export function createAutoCheckMessageHandler({
  client,
  isAutoCheckChannelFn = isAutoCheckChannel,
  getGuildLanguageFn = getGuildLanguage,
  extractNamesFromImageFn = extractNamesFromImage,
  checkNamesAgainstListsFn = checkNamesAgainstLists,
  formatCheckResultsFn = formatCheckResults,
  buildListCheckEmbedFn = buildListCheckEmbed,
  buildAutoCheckEvidenceRowFn = buildAutoCheckEvidenceRow,
  maxNames = AUTO_CHECK_MAX_NAMES,
  imageChecksEnabled = Boolean(config.geminiApiKey),
} = {}) {
  return async function handleAutoCheckMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const images = message.attachments.filter(
      (a) => a.contentType && a.contentType.startsWith('image/')
    );
    const image = images.first() || null;
    const textRequest = image ? null : parseAutoCheckText(message.content);

    if (!image && !textRequest) return;
    if (image && !imageChecksEnabled) return;

    if (!claimAutoCheckMessage(message.id)) return;
    let shouldRememberMessage = false;
    let lang = 'en';

    try {
      // Check if this channel is configured for auto-check
      const isActive = await isAutoCheckChannelFn(message.channelId, message.guild.id);
      if (!isActive) return;
      shouldRememberMessage = true;
      lang = await getGuildLanguageFn(message.guild.id, { GuildConfigModel: GuildConfig });

      // Per-user cooldown to prevent spam. The message claim above runs
      // before this async channel lookup can race with duplicate
      // MessageCreate deliveries or a duplicate listener in one process.
      const lastCheck = userCooldowns.get(message.author.id) || 0;
      if (Date.now() - lastCheck < COOLDOWN_MS) return;
      userCooldowns.set(message.author.id, Date.now());

      const inputKind = image ? 'image' : 'text';
      console.log(`[auto-check] ${inputKind} request from ${message.author.tag} in #${message.channel.name}, processing...`);

      await message.react('🔍').catch(() => {});

      if (textRequest?.invalidTokens.length > 0) {
        const tokens = textRequest.invalidTokens
          .slice(0, 5)
          .map((token) => `\`${String(token).slice(0, 40)}\``)
          .join(', ');
        await message.reply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            ...t('dialogue.check.text.invalid', lang, { tokens }),
            lang,
          })],
        });
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      let names = textRequest?.names || [];
      if (image) {
        names = await extractNamesFromImageFn(image, { refineAmbiguousDiacritics: true });
      }

      if (names.length === 0) {
        if (textRequest) {
          await message.reply({
            embeds: [buildAlertEmbed({
              severity: AlertSeverity.WARNING,
              ...t('dialogue.check.text.empty', lang),
              lang,
            })],
          });
        }
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      const limitedNames = names.slice(0, maxNames);

      // Send progress message immediately after OCR. Plain content here
      // (not an embed) because this is a transient "working on it" line
      // that gets edited into a full embed below within seconds.
      const progressMsg = await message.reply({
        content: `🔍 ${t(textRequest ? 'dialogue.check.text.progress' : 'dialogue.check.progress', lang, { count: limitedNames.length, word: t(`dialogue.check.${limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang) })}`,
      });

      const results = await checkNamesAgainstListsFn(limitedNames, { guildId: message.guild.id });
      const formattedLines = formatCheckResultsFn(results, lang);

      // Same embed builder as /la-list check; mode: 'auto' tweaks the
      // title verb ("Auto-check" vs "List Check") and the footer copy
      // (mentions the Quick-Add dropdown below).
      const { embed } = buildListCheckEmbedFn({
        results,
        formattedLines,
        limitedNamesCount: limitedNames.length,
        ignoredCount: names.length - limitedNames.length,
        maxNames,
        mode: 'auto',
        lang,
      });

      // Quick-Add dropdown for names with no DB list hit. Sits below
      // the embed so an officer can add a suspicious unlisted name
      // without retyping it.
      const unflaggedNames = results.filter(isQuickAddCandidate);
      const components = [];

      if (unflaggedNames.length > 0) {
        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('quickadd_select')
            .setPlaceholder(t('quickAdd.selectPlaceholder', lang))
            .addOptions(
              unflaggedNames.slice(0, 25).map((r) => ({
                label: r.name,
                description: t('quickAdd.noListHit', lang),
                value: r.name,
                emoji: '❓',
              }))
            )
        );
        components.push(selectRow);
      }

      // Evidence dropdown · second row when any flagged result has an
      // attached image. Mirrors /la-list view's design so officers can
      // audit evidence right from the auto-check card instead of
      // re-running /la-list view.
      const evidenceRow = buildAutoCheckEvidenceRowFn(results, lang);
      if (evidenceRow) components.push(evidenceRow);

      await progressMsg.edit({ content: '', embeds: [embed], components });
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('[auto-check] Error processing request:', err.message);
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('❌').catch(() => {});
      await message.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.check.autoFailed', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
          lang,
        })],
      }).catch(() => {});
    } finally {
      completeAutoCheckMessage(message.id, { processed: shouldRememberMessage });
    }
  };
}

/**
 * Set up the auto-check message listener.
 * @param {import('discord.js').Client} client
 */
export function setupAutoCheck(client) {
  if (!config.geminiApiKey) {
    console.log('[auto-check] GEMINI_API_KEY not set · screenshot OCR disabled; text check remains active.');
  }

  if (envChannelSet.size > 0) {
    console.log(`[auto-check] Env fallback channels: ${[...envChannelSet].join(', ')}`);
  }
  console.log('[auto-check] Listener active (checks DB GuildConfig + env fallback per message).');
  client.on(Events.MessageCreate, createAutoCheckMessageHandler({ client }));
}
