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
 * payload is stored as a serialized
 * snapshot so the resume can re-edit the message without re-running
 * the visible-roster scrape or the blacklist/whitelist match.
 *
 * State is process-local; on bot restart, in-flight sessions die with
 * the interaction tokens (Discord webhook reply window is 15 min).
 */

import { createExpiringSessionStore } from './expiringSessionStore.js';

const SESSION_TTL_MS = 5 * 60 * 1000;
const sessionStore = createExpiringSessionStore({ ttlMs: SESSION_TTL_MS });

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
 * @property {NodeJS.Timeout} expireTimer
 */

function createRosterDeepSession(payload) {
  return sessionStore.create(payload);
}

export function buildRosterContinuationSessionPayload({
  callerId,
  targetName,
  isHidden,
  meta,
  guildMembers,
  altResult,
  cap,
  primaryEmbedJSON,
}) {
  return {
    callerId,
    targetName,
    isHidden,
    meta,
    guildMembers,
    scannedNames: altResult.scannedNames || [],
    allDiscoveredAlts: altResult.alts || [],
    cap,
    scanStats: {
      scanned: altResult.scannedCandidates || 0,
      attempted: altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0,
      failed: altResult.failedCandidates || 0,
      rateLimitRetries: altResult.rateLimitRetries || 0,
    },
    primaryEmbedJSON,
  };
}

export function createRosterContinuationSession(options) {
  return createRosterDeepSession(buildRosterContinuationSessionPayload(options));
}

export function getRosterDeepSession(sessionId) {
  return sessionStore.get(sessionId);
}

export function refreshRosterDeepSession(session) {
  return sessionStore.refresh(session);
}

export function clearRosterDeepSession(sessionId) {
  sessionStore.clear(sessionId);
}
