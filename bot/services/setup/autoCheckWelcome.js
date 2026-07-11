import { EmbedBuilder } from 'discord.js';

import GuildConfig from '../../models/GuildConfig.js';
import {
  getGuildLanguage,
  getSupportedLanguages,
  t,
} from '../i18n/index.js';
import {
  cleanupAutoCheckChannelMessages,
  formatCleanupFailureReasons,
  getVietnamDayKey,
} from './autoCheckCleanup.js';
import { autoCheckChannelGuard } from './autoCheckChannelGuard.js';
import { COLORS } from '../../utils/ui.js';

function asText(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

export function buildAutoCheckWelcomeEmbed(lang, { cleanupEnabled = false } = {}) {
  const cleanupKey = cleanupEnabled ? 'cleanup' : 'cleanupDisabled';
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(t('autoCheckWelcome.title', lang))
    .setDescription(asText(t('autoCheckWelcome.description', lang)))
    .addFields(
      {
        name: t('autoCheckWelcome.howName', lang),
        value: asText(t('autoCheckWelcome.howValue', lang)),
      },
      {
        name: t('autoCheckWelcome.listsName', lang),
        value: asText(t('autoCheckWelcome.listsValue', lang)),
      },
      {
        name: t('autoCheckWelcome.scopeName', lang),
        value: asText(t('autoCheckWelcome.scopeValue', lang)),
      },
      // cleanupKey toggles the on/off variant; keep it at index 3 so the
      // channel's cleanup posture stays the middle beat of the guide.
      {
        name: t(`autoCheckWelcome.${cleanupKey}Name`, lang),
        value: asText(t(`autoCheckWelcome.${cleanupKey}Value`, lang)),
      },
      {
        name: t('autoCheckWelcome.quickAddName', lang),
        value: asText(t('autoCheckWelcome.quickAddValue', lang)),
      },
      {
        name: t('autoCheckWelcome.commandsName', lang),
        value: asText(t('autoCheckWelcome.commandsValue', lang)),
      }
    )
    .setFooter({ text: t('autoCheckWelcome.footer', lang) });
}

function pinnedMessages(response) {
  const items = response?.items || response;
  if (!items) return [];
  const pins = typeof items.values === 'function'
    ? [...items.values()]
    : Array.isArray(items)
      ? items
      : [];
  return pins.map((pin) => pin?.message || pin).filter(Boolean);
}

export function createAutoCheckWelcomeService({
  GuildConfigModel = GuildConfig,
  buildWelcomeEmbed = buildAutoCheckWelcomeEmbed,
  getGuildLanguageFn = getGuildLanguage,
  cleanupMessages = cleanupAutoCheckChannelMessages,
  getCleanupDayKey = getVietnamDayKey,
  channelGuard = autoCheckChannelGuard,
  supportedLanguageCodes = getSupportedLanguages().map((entry) => entry.code),
  logger = console,
} = {}) {
  const titleSignatures = new Set(
    supportedLanguageCodes
      .map((lang) => {
        try {
          const embed = buildWelcomeEmbed(lang);
          return embed?.toJSON?.()?.title || embed?.data?.title || '';
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );

  function isOwnedWelcome(message, botUserId) {
    if (!message || message.author?.id !== botUserId) return false;
    const title = message.embeds?.[0]?.title || '';
    return titleSignatures.has(title);
  }

  async function loadStoredConfig(guildId) {
    try {
      return await GuildConfigModel.findOne({ guildId }).lean();
    } catch (err) {
      logger.warn?.('[auto-check welcome] config read failed:', err?.message || err);
      return null;
    }
  }

  async function collectStaleRefs(channel, botUserId, stored) {
    const refs = new Map();
    let pinScanSucceeded = false;
    let hadOwnedWelcomePin = false;
    const pinnedMessageIds = new Set();
    const add = (channelId, messageId, message = null) => {
      if (!channelId || !messageId) return;
      refs.set(channelId + ':' + messageId, { channelId, messageId, message });
    };

    add(
      stored?.autoCheckWelcomeChannelId || channel.id,
      stored?.autoCheckWelcomeMessageId
    );

    try {
      const response = await channel.messages.fetchPins();
      pinScanSucceeded = true;
      for (const message of pinnedMessages(response)) {
        if (message.id) pinnedMessageIds.add(String(message.id));
        if (isOwnedWelcome(message, botUserId)) {
          hadOwnedWelcomePin = true;
          add(channel.id, message.id, message);
        }
      }
    } catch (err) {
      logger.warn?.('[auto-check welcome] pin scan failed:', err?.message || err);
    }
    return { refs, pinScanSucceeded, hadOwnedWelcomePin, pinnedMessageIds };
  }

  async function rollbackFresh(sent) {
    try {
      await sent.unpin();
    } catch (err) {
      logger.warn?.('[auto-check welcome] fresh unpin rollback failed:', err?.message || err);
    }
    try {
      await sent.delete();
    } catch (err) {
      logger.warn?.('[auto-check welcome] fresh delete rollback failed:', err?.message || err);
    }
  }

  async function resolveStaleMessage(ref, channel, client) {
    if (ref.message) return ref.message;
    try {
      const sourceChannel = ref.channelId === channel.id
        ? channel
        : await client?.channels?.fetch?.(ref.channelId);
      return await sourceChannel?.messages?.fetch?.(ref.messageId);
    } catch {
      return null;
    }
  }

  async function deleteStaleRefs(refs, channel, client, outcome) {
    for (const ref of refs.values()) {
      const message = await resolveStaleMessage(ref, channel, client);
      if (!message) continue;
      try {
        await message.delete();
        outcome.removedOldCount += 1;
      } catch {
        // Already gone or no longer accessible.
      }
    }
  }

  async function postWelcomeLocked({
    botUserId,
    channel,
    client,
    cleanupEnabled = false,
    configSet = {},
    guildId,
  }) {
    const outcome = {
      posted: false,
      pinned: false,
      persisted: false,
      removedOldCount: 0,
      pinScanSucceeded: false,
      hadOwnedWelcomePin: false,
      cleanupAttempted: false,
      cleanupComplete: false,
      cleanupDeleted: 0,
      cleanupFailed: 0,
      cleanupTruncated: false,
      cleanupFailureReasons: {},
    };
    const stored = await loadStoredConfig(guildId);
    const pinState = await collectStaleRefs(channel, botUserId, stored);
    const { refs: staleRefs } = pinState;
    outcome.pinScanSucceeded = pinState.pinScanSucceeded;
    outcome.hadOwnedWelcomePin = pinState.hadOwnedWelcomePin;
    const lang = await getGuildLanguageFn(guildId, {
      GuildConfigModel,
    });

    // A channel without a live LoaLogs welcome pin is considered a first-time
    // setup surface. Clean non-pinned traffic before creating the guide so the
    // guide becomes the stable top-level anchor instead of landing below an
    // inherited wall of messages. If pin discovery itself failed, skip this
    // destructive step and let the daily scheduler retry safely later.
    if (cleanupEnabled && outcome.pinScanSucceeded && !outcome.hadOwnedWelcomePin) {
      outcome.cleanupAttempted = true;
      try {
        const cleanup = await cleanupMessages(channel, {
          protectedMessageIds: pinState.pinnedMessageIds,
        });
        outcome.cleanupDeleted = Number(cleanup?.deleted) || 0;
        outcome.cleanupFailed = Number(cleanup?.failed) || 0;
        outcome.cleanupTruncated = Boolean(cleanup?.truncated);
        outcome.cleanupFailureReasons = cleanup?.failureReasons || {};
        outcome.cleanupComplete = outcome.cleanupFailed === 0 && !outcome.cleanupTruncated;
        if (!outcome.cleanupComplete) {
          const failureSummary = formatCleanupFailureReasons(outcome.cleanupFailureReasons);
          logger.warn?.(
            '[auto-check welcome] initial cleanup incomplete: deleted=' + outcome.cleanupDeleted +
            ' failed=' + outcome.cleanupFailed +
            ' truncated=' + outcome.cleanupTruncated +
            (failureSummary ? ' errors=' + failureSummary : '')
          );
        }
      } catch (err) {
        outcome.cleanupFailed = 1;
        logger.warn?.('[auto-check welcome] initial cleanup failed:', err?.message || err);
      }
    }

    let sent;
    try {
      sent = await channel.send({
        embeds: [buildWelcomeEmbed(lang, { cleanupEnabled })],
      });
      outcome.posted = true;
      await sent.pin();
      outcome.pinned = true;
    } catch (err) {
      logger.warn?.('[auto-check welcome] send or pin failed:', err?.message || err);
      if (sent) await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    try {
      const persistedState = {
        ...(configSet && typeof configSet === 'object' ? configSet : {}),
        autoCheckWelcomeMessageId: sent.id,
        autoCheckWelcomeChannelId: channel.id,
      };
      if (outcome.cleanupComplete) {
        persistedState.lastAutoCheckCleanupKey = getCleanupDayKey();
      }
      await GuildConfigModel.findOneAndUpdate(
        { guildId },
        {
          $set: persistedState,
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
      outcome.persisted = true;
      channelGuard.rememberWelcome(channel.id, sent.id);
      if (
        stored?.autoCheckWelcomeChannelId &&
        stored.autoCheckWelcomeChannelId !== channel.id
      ) {
        channelGuard.forgetWelcome(
          stored.autoCheckWelcomeChannelId,
          stored.autoCheckWelcomeMessageId
        );
      }
    } catch (err) {
      logger.warn?.('[auto-check welcome] pin persistence failed:', err?.message || err);
      await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    await deleteStaleRefs(staleRefs, channel, client, outcome);
    return outcome;
  }

  async function postWelcome(options) {
    return channelGuard.runExclusive(
      options?.channel?.id,
      () => postWelcomeLocked(options)
    );
  }

  return {
    postWelcome,
  };
}

const productionWelcomeService = createAutoCheckWelcomeService();

export function postAutoCheckWelcome(options) {
  return productionWelcomeService.postWelcome(options);
}
