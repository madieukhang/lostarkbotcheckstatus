import { createExpiringSessionStore } from '../../../utils/expiringSessionStore.js';
import { normalizeNameKey } from '../../../utils/names.js';

const ENRICH_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 5 * 60 * 1000;

const enrichCooldown = new Map();
const sessionStore = createExpiringSessionStore({ ttlMs: SESSION_TTL_MS });

export function getCooldownWaitSeconds(name) {
  const cooldownKey = normalizeNameKey(name);
  const lastRun = enrichCooldown.get(cooldownKey);
  if (!lastRun) return 0;
  const remainingMs = ENRICH_COOLDOWN_MS - (Date.now() - lastRun);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function markCooldown(name) {
  enrichCooldown.set(normalizeNameKey(name), Date.now());
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
