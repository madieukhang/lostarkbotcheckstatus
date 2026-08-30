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

/**
 * Transactional pinned-welcome lifecycle shared by setup-managed channels.
 * A fresh guide is sent, pinned, and persisted before any tracked/orphaned
 * predecessor is removed. A failed pin or DB write rolls the fresh message
 * back, leaving the prior guide and config intact.
 */
export function createPinnedWelcomeService({
  GuildConfigModel,
  buildWelcomeEmbed,
  getGuildLanguageFn,
  channelGuard,
  supportedLanguageCodes,
  messageIdField,
  channelIdField,
  logLabel = 'channel welcome',
  logger = console,
  createOutcome = () => ({}),
  beforeSend = null,
} = {}) {
  const titleSignatures = new Set(
    supportedLanguageCodes
      .map((lang) => {
        try {
          const embed = buildWelcomeEmbed(lang, {});
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
      logger.warn?.(`[${logLabel}] config read failed:`, err?.message || err);
      return null;
    }
  }

  async function collectStaleRefs(channel, botUserId, stored) {
    const refs = new Map();
    let pinScanSucceeded = false;
    let hadOwnedWelcomePin = false;
    const pinnedMessageIds = new Set();
    const add = (refChannelId, messageId, message = null) => {
      if (!refChannelId || !messageId) return;
      refs.set(refChannelId + ':' + messageId, {
        channelId: refChannelId,
        messageId,
        message,
      });
    };

    add(stored?.[channelIdField] || channel.id, stored?.[messageIdField]);

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
      logger.warn?.(`[${logLabel}] pin scan failed:`, err?.message || err);
    }
    return { refs, pinScanSucceeded, hadOwnedWelcomePin, pinnedMessageIds };
  }

  async function rollbackFresh(sent) {
    try {
      await sent.unpin();
    } catch (err) {
      logger.warn?.(`[${logLabel}] fresh unpin rollback failed:`, err?.message || err);
    }
    try {
      await sent.delete();
    } catch (err) {
      logger.warn?.(`[${logLabel}] fresh delete rollback failed:`, err?.message || err);
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

  async function postWelcomeLocked(options) {
    const {
      botUserId,
      channel,
      client,
      configSet = {},
      guildId,
    } = options;
    const outcome = {
      posted: false,
      pinned: false,
      persisted: false,
      removedOldCount: 0,
      pinScanSucceeded: false,
      hadOwnedWelcomePin: false,
      ...createOutcome(options),
    };
    const stored = await loadStoredConfig(guildId);
    const pinState = await collectStaleRefs(channel, botUserId, stored);
    outcome.pinScanSucceeded = pinState.pinScanSucceeded;
    outcome.hadOwnedWelcomePin = pinState.hadOwnedWelcomePin;
    const lang = await getGuildLanguageFn(guildId, { GuildConfigModel });

    let extraPersistedState = {};
    if (typeof beforeSend === 'function') {
      extraPersistedState = await beforeSend({
        botUserId,
        channel,
        client,
        guildId,
        lang,
        options,
        outcome,
        pinState,
        stored,
      }) || {};
    }

    let sent;
    try {
      sent = await channel.send({
        embeds: [buildWelcomeEmbed(lang, options)],
      });
      outcome.posted = true;
      await sent.pin();
      outcome.pinned = true;
    } catch (err) {
      logger.warn?.(`[${logLabel}] send or pin failed:`, err?.message || err);
      if (sent) await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    try {
      const persistedState = {
        ...(configSet && typeof configSet === 'object' ? configSet : {}),
        ...extraPersistedState,
        [messageIdField]: sent.id,
        [channelIdField]: channel.id,
      };
      await GuildConfigModel.findOneAndUpdate(
        { guildId },
        { $set: persistedState },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
      outcome.persisted = true;
      channelGuard.rememberWelcome(channel.id, sent.id);
      if (
        stored?.[channelIdField] &&
        stored?.[messageIdField] &&
        String(stored[messageIdField]) !== String(sent.id)
      ) {
        channelGuard.forgetWelcome(
          stored[channelIdField],
          stored[messageIdField]
        );
      }
    } catch (err) {
      logger.warn?.(`[${logLabel}] pin persistence failed:`, err?.message || err);
      await rollbackFresh(sent);
      outcome.pinned = false;
      return outcome;
    }

    await deleteStaleRefs(pinState.refs, channel, client, outcome);
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
    postWelcomeLocked,
  };
}
