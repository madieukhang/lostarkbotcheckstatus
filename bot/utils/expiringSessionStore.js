/**
 * Small process-local session store with sliding expiration.
 *
 * Callers own the payload shape; this helper only standardizes IDs, timestamps,
 * timer replacement, lookup, and cleanup so every interactive flow follows the
 * same TTL lifecycle.
 */
export function createExpiringSessionStore({
  ttlMs,
  createId = () => Math.random().toString(36).slice(2, 12),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!(Number(ttlMs) > 0)) {
    throw new TypeError('createExpiringSessionStore requires a positive ttlMs');
  }

  const sessions = new Map();

  function scheduleExpiry(session) {
    if (session.expireTimer) clearTimer(session.expireTimer);
    session.expireTimer = setTimer(() => sessions.delete(session.sessionId), ttlMs);
    return session;
  }

  function create(payload) {
    const session = {
      ...payload,
      sessionId: createId(),
      createdAt: now(),
      expireTimer: null,
    };
    scheduleExpiry(session);
    sessions.set(session.sessionId, session);
    return session;
  }

  function get(sessionId) {
    return sessions.get(sessionId) || null;
  }

  function touch(sessionId) {
    const session = get(sessionId);
    if (!session) return null;
    return scheduleExpiry(session);
  }

  function refresh(session) {
    if (!session?.sessionId) return null;
    scheduleExpiry(session);
    sessions.set(session.sessionId, session);
    return session;
  }

  function clear(sessionId) {
    const session = get(sessionId);
    if (session?.expireTimer) clearTimer(session.expireTimer);
    sessions.delete(sessionId);
  }

  return {
    clear,
    create,
    get,
    refresh,
    touch,
  };
}
