/**
 * rosterDeepSession.js
 *
 * In-memory session store for the /la-roster deep:true command's
 * Continue-scan resume button. Mirrors the enrich-session pattern but
 * tailored for the read-only roster lookup (no DB write at confirm,
 * no preview/cancel matrix - just resume support).
 *
 * Each session caches the meta + guild member fetches from the original
 * scan so a Continue click does not re-fetch them. The primary-embed
 * payload (roster card + content lines) is stored as a serialized
 * snapshot so the resume can re-edit the message without re-running
 * the visible-roster scrape or the blacklist/whitelist match.
 *
 * State is process-local; on bot restart, in-flight sessions die with
 * the interaction tokens (Discord webhook reply window is 15 min).
 */

const SESSION_TTL_MS = 5 * 60 * 1000;

const sessions = new Map();

function newSessionId() {
  return Math.random().toString(36).slice(2, 12);
}

/**
 * @typedef RosterDeepSession
 * @property {string} sessionId
 * @property {string} callerId
 * @property {string} targetName
 * @property {boolean} isHidden
 * @property {object} meta - lostark.bible character meta (cached)
 * @property {Array<object>} guildMembers - cached guild member list
 * @property {Array<string>} scannedNames - cumulative across passes
 * @property {Array<object>} allDiscoveredAlts - cumulative alts
 * @property {number} [cap] - candidate limit for the scan
 * @property {Array<object>} primaryEmbedJSON - first-embed snapshot rebuilt on Continue
 * @property {string} [contentText] - optional message content prefix (visible path)
 * @property {NodeJS.Timeout} expireTimer
 */

export function createRosterDeepSession(payload) {
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

export function getRosterDeepSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function touchRosterDeepSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expireTimer) clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);
  return session;
}

export function refreshRosterDeepSession(session) {
  if (!session?.sessionId) return null;
  if (session.expireTimer) clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => sessions.delete(session.sessionId), SESSION_TTL_MS);
  sessions.set(session.sessionId, session);
  return session;
}

export function clearRosterDeepSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.expireTimer) clearTimeout(session.expireTimer);
  sessions.delete(sessionId);
}
