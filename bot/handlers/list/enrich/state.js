import { createExpiringSessionStore } from '../../../utils/expiringSessionStore.js';
import { createCooldownStore } from '../../../utils/cooldownStore.js';
import { normalizeNameKey } from '../../../utils/names.js';

const ENRICH_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 5 * 60 * 1000;

const enrichCooldown = createCooldownStore(ENRICH_COOLDOWN_MS);
const sessionStore = createExpiringSessionStore({ ttlMs: SESSION_TTL_MS });

/**
 * @param {string} name Character whose scan cooldown is checked.
 * @returns {number} Remaining cooldown rounded up to seconds.
 */
export function getCooldownWaitSeconds(name) {
  return Math.ceil(enrichCooldown.remainingMs(normalizeNameKey(name)) / 1000);
}

/**
 * @param {string} name Character whose scan starts now.
 * @returns {void}
 */
export function markCooldown(name) {
  enrichCooldown.mark(normalizeNameKey(name));
}

export function createEnrichSession(payload) {
  return sessionStore.create(payload);
}

/**
 * Refresh the TTL on an existing session so a Continue-scan resume does
 * not race the 5-minute expiry that started when the original scan
 * landed. Mutates the session in-place; returns the session for chain.
 */
export function touchEnrichSession(sessionId) {
  return sessionStore.touch(sessionId);
}

/**
 * Keep a long-running Continue pass alive while the worker is active.
 * `touchEnrichSession()` only works while the session is still in the
 * map; a 10-15 minute resume can otherwise outlive the 5-minute action
 * TTL and render fresh buttons backed by an expired session.
 */
export function refreshEnrichSession(session) {
  return sessionStore.refresh(session);
}

export function getEnrichSession(sessionId) {
  return sessionStore.get(sessionId);
}

export function clearEnrichSession(sessionId) {
  sessionStore.clear(sessionId);
}
