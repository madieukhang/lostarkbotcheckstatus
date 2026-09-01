/**
 * Serialize destructive channel lifecycle work and remember welcome messages
 * that must survive a cleanup sweep. Auto-check and list-notification flows
 * deliberately share the same singleton because they may target one channel.
 */
export function createChannelLifecycleGuard() {
  const channelTails = new Map();
  const welcomeMessageIds = new Map();

  async function runExclusive(channelId, task) {
    const key = String(channelId || '');
    if (!key) return task();

    const previous = (channelTails.get(key) || Promise.resolve()).catch(() => {});
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    channelTails.set(key, tail);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (channelTails.get(key) === tail) channelTails.delete(key);
    }
  }

  function rememberWelcome(channelId, messageId) {
    if (!channelId || !messageId) return;
    const key = String(channelId);
    const ids = welcomeMessageIds.get(key) || new Set();
    ids.add(String(messageId));
    welcomeMessageIds.set(key, ids);
  }

  function forgetWelcome(channelId, messageId) {
    if (!channelId) return;
    const key = String(channelId);
    if (!messageId) {
      welcomeMessageIds.delete(key);
      return;
    }
    const ids = welcomeMessageIds.get(key);
    if (!ids) return;
    ids.delete(String(messageId));
    if (ids.size === 0) welcomeMessageIds.delete(key);
  }

  function getProtectedMessageIds(channelId) {
    return [...(welcomeMessageIds.get(String(channelId || '')) || [])];
  }

  return {
    forgetWelcome,
    getProtectedMessageIds,
    rememberWelcome,
    runExclusive,
  };
}

export const channelLifecycleGuard = createChannelLifecycleGuard();
