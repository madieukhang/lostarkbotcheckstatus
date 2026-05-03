const ENRICH_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 5 * 60 * 1000;

const enrichCooldown = new Map();
const sessions = new Map();

function newSessionId() {
  return Math.random().toString(36).slice(2, 12);
}

export function getCooldownWaitSeconds(name) {
  const cooldownKey = name.toLowerCase();
  const lastRun = enrichCooldown.get(cooldownKey);
  if (!lastRun) return 0;
  const remainingMs = ENRICH_COOLDOWN_MS - (Date.now() - lastRun);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function markCooldown(name) {
  enrichCooldown.set(name.toLowerCase(), Date.now());
}

export function createEnrichSession(payload) {
  const sessionId = newSessionId();
  const expireTimer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);
  const session = {
    ...payload,
    sessionId,
    createdAt: Date.now(),
    expireTimer,
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Refresh the TTL on an existing session so a Continue-scan resume does
 * not race the 5-minute expiry that started when the original scan
 * landed. Mutates the session in-place; returns the session for chain.
 */
export function touchEnrichSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expireTimer) clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);
  return session;
}

/**
 * Keep a long-running Continue pass alive while the worker is active.
 * `touchEnrichSession()` only works while the session is still in the
 * map; a 10-15 minute resume can otherwise outlive the 5-minute action
 * TTL and render fresh buttons backed by an expired session.
 */
export function refreshEnrichSession(session) {
  if (!session?.sessionId) return null;
  if (session.expireTimer) clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => sessions.delete(session.sessionId), SESSION_TTL_MS);
  sessions.set(session.sessionId, session);
  return session;
}

export function getEnrichSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function clearEnrichSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.expireTimer) clearTimeout(session.expireTimer);
  sessions.delete(sessionId);
}
