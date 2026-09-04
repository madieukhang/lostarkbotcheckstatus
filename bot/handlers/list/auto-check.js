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
  isCharacterIdentityVerified,
  partitionListCheckResultsByVerification,
} from '../../services/list-check/service.js';
import { createNameSuggestionContext } from '../../services/roster/search.js';
import { getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, buildNoticeEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { buildListCheckEmbed } from '../../utils/listCheckEmbed.js';
import {
  isValidCharacterName,
  normalizeCharacterName,
  normalizeNameKey,
} from '../../utils/names.js';
import { getGuildLanguage, t, tPick } from '../../services/i18n/index.js';
import { buildAutoCheckEvidenceRow } from './check/index.js';

/** Env-based channel set (global fallback) */
const envChannelSet = new Set(config.autoCheckChannelIds);

/** Per-user cooldown to prevent spam (userId → timestamp) */
const userCooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10 seconds between checks per user
const processedMessages = new Map(); // messageId -> timestamp
const inFlightMessages = new Set();
const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const AUTO_CHECK_MAX_NAMES = 8;
const AUTO_CHECK_MAX_IMAGES = 3;

// Gemini OCR is intentionally serialized. A burst of two or three screenshots
// should become visible queued work instead of concurrent requests that compete
// for the same API quota and are more likely to fail with 429/503 responses.
let imageRequestQueueTail = Promise.resolve();
let queuedImageRequestCount = 0;

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
    if (!isValidCharacterName(token)) {
      invalidTokens.push(token);
      continue;
    }
    const name = normalizeCharacterName(token);
    const key = normalizeNameKey(name);
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
  imageRequestQueueTail = Promise.resolve();
  queuedImageRequestCount = 0;
}

/**
 * Run one screenshot request at a time while exposing how many requests are
 * already ahead of the caller. A single request may contain up to three
 * attachments; those are also read sequentially inside that queue slot.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {(waitingAhead: number) => Promise<void>} [onQueued]
 * @returns {Promise<T>}
 */
async function runQueuedImageRequest(task, onQueued) {
  const waitingAhead = queuedImageRequestCount;
  queuedImageRequestCount += 1;

  const previous = imageRequestQueueTail.catch(() => {});
  let releaseSlot;
  const currentSlot = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  imageRequestQueueTail = previous.then(() => currentSlot);

  try {
    if (waitingAhead > 0) await onQueued?.(waitingAhead);
    await previous;
    return await task();
  } finally {
    queuedImageRequestCount -= 1;
    releaseSlot();
    if (queuedImageRequestCount === 0) imageRequestQueueTail = Promise.resolve();
  }
}

/**
 * Keep Quick Add limited to verified characters that have no existing list
 * record. This prevents raw OCR/text noise from becoming a moderation entry.
 * @param {object} result - verified list-check result
 * @returns {boolean} true when the character is eligible for Quick Add
 */
export function isQuickAddCandidate(result) {
  return isCharacterIdentityVerified(result)
    && !result.blackEntry
    && !result.whiteEntry
    && !result.watchEntry
    && !result.trustedEntry;
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
  function resolveRequest(message) {
    const imageAttachments = message.attachments.filter(
      (attachment) => attachment.contentType?.startsWith('image/')
    );
    const allImages = [...imageAttachments.values()];
    const images = allImages.slice(0, AUTO_CHECK_MAX_IMAGES);
    const textRequest = images.length > 0 ? null : parseAutoCheckText(message.content);
    if (images.length === 0 && !textRequest) return null;
    if (images.length > 0 && !imageChecksEnabled) return null;
    return {
      images,
      textRequest,
      ignoredImageCount: allImages.length - images.length,
    };
  }

  async function removeSearchReaction(message) {
    await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
  }

  async function rejectInvalidTextRequest(message, textRequest, lang) {
    if (!textRequest || textRequest.invalidTokens.length === 0) return false;
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
    await removeSearchReaction(message);
    return true;
  }

  async function setProgressMessage(message, requestUi, lines, lang) {
    const payload = {
      content: null,
      embeds: [buildNoticeEmbed(lines.filter(Boolean).join('\n'), {
        severity: AlertSeverity.INFO,
        titleIcon: '⏳',
        lang,
      })],
      components: [],
    };
    if (requestUi.progressMsg) {
      await requestUi.progressMsg.edit(payload);
      return requestUi.progressMsg;
    }
    requestUi.progressMsg = await message.reply(payload);
    return requestUi.progressMsg;
  }

  function imageLimitLine(request, lang) {
    if (!request.ignoredImageCount) return null;
    return t('dialogue.check.imageIgnored', lang, {
      count: request.ignoredImageCount,
      limit: AUTO_CHECK_MAX_IMAGES,
    });
  }

  async function rejectEmptyNames(message, request, requestUi, lang) {
    const alert = request.textRequest
      ? t('dialogue.check.text.empty', lang)
      : t('dialogue.check.noNames', lang);
    const payload = {
      content: null,
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...alert,
        lang,
      })],
      components: [],
    };
    if (requestUi.progressMsg) await requestUi.progressMsg.edit(payload);
    else await message.reply(payload);
    await removeSearchReaction(message);
  }

  function mergeUniqueNames(target, names, seen) {
    for (const rawName of names) {
      // OCR already returns display-ready names. Preserve that casing while
      // using the canonical key only for cross-image deduplication.
      const name = String(rawName ?? '').trim();
      const key = normalizeNameKey(name);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      target.push(name);
    }
  }

  function buildAutoCheckComponents(results, lang) {
    const components = [];
    const unflaggedNames = results.filter(isQuickAddCandidate);
    if (unflaggedNames.length > 0) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('quickadd_select')
          .setPlaceholder(t('quickAdd.selectPlaceholder', lang))
          .addOptions(unflaggedNames.slice(0, 25).map((result) => ({
            label: result.name,
            description: t('quickAdd.noListHit', lang),
            value: result.name,
            emoji: '❓',
          })))
      ));
    }
    const evidenceRow = buildAutoCheckEvidenceRowFn(results, lang);
    if (evidenceRow) components.push(evidenceRow);
    return components;
  }

  async function rejectUnverifiedBatch(message, progressMsg, unverifiedCount, lang) {
    await progressMsg.edit({
      content: null,
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.noVerifiedNames', lang, { count: unverifiedCount }),
        lang,
      })],
      components: [],
    });
    await removeSearchReaction(message);
    await message.react('⚠️').catch(() => {});
  }

  async function processAutoCheckRequest(message, request, requestUi, lang) {
    const startedAt = requestUi.startedAt;
    const inputKind = request.images.length > 0 ? 'image' : 'text';
    console.log(`[auto-check] ${inputKind} request from ${message.author.tag} in #${message.channel.name}, processing...`);
    await message.react('🔍').catch(() => {});
    if (await rejectInvalidTextRequest(message, request.textRequest, lang)) return;

    const suggestionContext = createNameSuggestionContext({
      maxNetworkLookups: config.listcheckSuggestionLookupBudget,
    });
    const names = [];
    if (request.images.length > 0) {
      const seenNames = new Set();
      for (const [index, image] of request.images.entries()) {
        await setProgressMessage(message, requestUi, [
          t('dialogue.check.imageProgress', lang, {
            current: index + 1,
            count: request.images.length,
          }),
          imageLimitLine(request, lang),
        ], lang);
        const extractedNames = await extractNamesFromImageFn(image, {
          refineAmbiguousDiacritics: true,
          suggestionCache: suggestionContext.cache,
          suggestionContext,
        });
        mergeUniqueNames(names, extractedNames, seenNames);
      }
    } else {
      mergeUniqueNames(names, request.textRequest?.names || [], new Set());
    }

    if (names.length === 0) {
      await rejectEmptyNames(message, request, requestUi, lang);
      return;
    }

    const limitedNames = names.slice(0, maxNames);
    await setProgressMessage(message, requestUi, [
      tPick(request.textRequest ? 'dialogue.check.text.progress' : 'dialogue.check.progress', lang, {
        count: limitedNames.length,
        word: t(`dialogue.check.${limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang),
      }),
      imageLimitLine(request, lang),
    ], lang);
    const checkedResults = await checkNamesAgainstListsFn(limitedNames, {
      guildId: message.guild.id,
      inputSource: request.images.length > 0 ? 'ocr' : 'text',
      suggestionCache: suggestionContext.cache,
      suggestionContext,
    });
    const { verified: results, unverified } = partitionListCheckResultsByVerification(checkedResults);
    if (results.length === 0) {
      await rejectUnverifiedBatch(message, requestUi.progressMsg, unverified.length, lang);
      return;
    }

    const { embed } = buildListCheckEmbedFn({
      results,
      formattedLines: formatCheckResultsFn(results, lang),
      limitedNamesCount: limitedNames.length,
      ignoredCount: names.length - limitedNames.length,
      unverifiedCount: unverified.length,
      maxNames,
      mode: 'auto',
      lang,
      elapsedMs: Date.now() - startedAt,
    });
    await requestUi.progressMsg.edit({
      content: null,
      embeds: [embed],
      components: buildAutoCheckComponents(results, lang),
    });
    await removeSearchReaction(message);
    await message.react('✅').catch(() => {});
  }

  return async function handleAutoCheckMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    const request = resolveRequest(message);
    if (!request) return;
    if (!claimAutoCheckMessage(message.id)) return;
    let shouldRememberMessage = false;
    let lang = 'en';
    const requestUi = { progressMsg: null, startedAt: Date.now() };

    try {
      // Check if this channel is configured for auto-check
      const isActive = await isAutoCheckChannelFn(message.channelId, message.guild.id);
      if (!isActive) return;
      shouldRememberMessage = true;
      lang = await getGuildLanguageFn(message.guild.id, { GuildConfigModel: GuildConfig });

      if (request.images.length > 0) {
        await runQueuedImageRequest(
          () => processAutoCheckRequest(message, request, requestUi, lang),
          async (waitingAhead) => {
            await setProgressMessage(message, requestUi, [
              t('dialogue.check.imageQueued', lang, { count: waitingAhead }),
              imageLimitLine(request, lang),
            ], lang);
          }
        );
      } else {
        // Text-only checks remain rate-limited. Screenshot work is queued
        // instead, so rapid image messages are never silently discarded.
        const lastCheck = userCooldowns.get(message.author.id) || 0;
        if (Date.now() - lastCheck < COOLDOWN_MS) return;
        userCooldowns.set(message.author.id, Date.now());
        await processAutoCheckRequest(message, request, requestUi, lang);
      }
    } catch (err) {
      console.error('[auto-check] Error processing request:', err.message);
      await removeSearchReaction(message);
      await message.react('❌').catch(() => {});
      const errorPayload = {
        content: null,
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.check.autoFailed', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
          lang,
        })],
        components: [],
      };
      if (requestUi.progressMsg) {
        await requestUi.progressMsg.edit(errorPayload).catch(() => {});
      } else {
        await message.reply(errorPayload).catch(() => {});
      }
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
