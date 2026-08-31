/**
 * serverStatus.js
 * Fetches and parses the Lost Ark server status page to determine
 * the current status of a target server (e.g. "Thaemine").
 *
 * Real DOM structure (per live page inspection):
 *
 *  <div class="ags-ServerStatus-content-responses-response-server">
 *    <div class="ags-ServerStatus-content-responses-response-server-status-wrapper">
 *      <div class="ags-ServerStatus-content-responses-response-server-status
 *                  ags-ServerStatus-content-responses-response-server-status--good">
 *        <svg …/>
 *      </div>
 *    </div>
 *    <div aria-label="Thaemine is online"
 *         class="ags-ServerStatus-content-responses-response-server-name">
 *      Thaemine
 *    </div>
 *  </div>
 *
 * Modifier classes on the inner status div:
 *   --good        → online
 *   --busy        → online  (busy but playable)
 *   --full        → online  (full but playable)
 *   --maintenance → maintenance
 *   (no modifier) → offline
 */

import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import config from '../config.js';

// ─── Status constants ─────────────────────────────────────────────────────────

export const STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  MAINTENANCE: 'maintenance',
  UNKNOWN: 'unknown',
};

// Exact class name prefixes from the live page – kept as constants so a
// single change here updates every selector in the file.
const CLS = {
  SERVER_ROW:  'ags-ServerStatus-content-responses-response-server',
  SERVER_NAME: 'ags-ServerStatus-content-responses-response-server-name',
  // The inner status div (NOT the wrapper) carries the modifier, e.g.
  // "…-server-status  …-server-status--good". The wrapper ends with "-wrapper"
  // and never has a "--" modifier suffix.
  STATUS_DIV:  'ags-ServerStatus-content-responses-response-server-status',
};

// ─── Resolver helpers ─────────────────────────────────────────────────────────

/**
 * Determine status from the inner status <div> className string.
 * Only the modifier suffix determines the state; the wrapper has no modifier.
 *
 * @param {string} className - Full className of the status element
 * @returns {string}
 */
function resolveStatusFromClass(className) {
  const classTokens = String(className || '').toLowerCase().split(/\s+/).filter(Boolean);
  const baseClass = CLS.STATUS_DIV.toLowerCase();
  const modifiers = new Set(
    classTokens.filter((token) => token.startsWith(`${baseClass}--`))
  );

  const rules = [
    {
      matches: () => ['good', 'busy', 'full']
        .some((modifier) => modifiers.has(`${baseClass}--${modifier}`)),
      status: STATUS.ONLINE,
    },
    {
      matches: () => modifiers.has(`${baseClass}--maintenance`),
      status: STATUS.MAINTENANCE,
    },
    // The live page represents offline with the base status class and no
    // modifier. An unfamiliar modifier is schema drift, not proof of offline.
    {
      matches: () => classTokens.includes(baseClass) && modifiers.size === 0,
      status: STATUS.OFFLINE,
    },
  ];
  return rules.find(({ matches }) => matches())?.status || STATUS.UNKNOWN;
}

/**
 * Determine status from the aria-label attribute on the server name element.
 * The live page uses labels like "Thaemine is online" / "Thaemine is offline".
 * This is the most reliable signal because it is human-readable plain text.
 *
 * @param {string} ariaLabel
 * @returns {string}
 */
function resolveStatusFromAriaLabel(ariaLabel) {
  const label = String(ariaLabel || '').toLowerCase();
  const rules = [
    { tokens: ['maintenance'], status: STATUS.MAINTENANCE },
    { tokens: ['offline'], status: STATUS.OFFLINE },
    { tokens: ['online', 'busy', 'full'], status: STATUS.ONLINE },
  ];
  return rules.find(({ tokens }) => tokens.some((token) => label.includes(token)))?.status
    || STATUS.UNKNOWN;
}

/**
 * Parse an already-fetched status page. Kept separate from network I/O so
 * live markup variants can be covered by deterministic fixtures.
 *
 * @param {string} html
 * @param {string[]} serverNames
 * @param {object} [options]
 * @param {object} [options.logger=console]
 * @returns {Map<string, string>}
 */
export function parseServerStatuses(html, serverNames, { logger = console } = {}) {
  const { document } = new JSDOM(html).window;
  const serverRows = document.querySelectorAll(`.${CLS.SERVER_ROW}`);

  logger.log?.(`[serverStatus] Checking ${serverNames.length} server(s): ${serverNames.join(', ')}`);

  const targetByLowerName = new Map(serverNames.map((name) => [name.toLowerCase(), name]));
  const statusMap = new Map();

  for (const row of serverRows) {
    const nameEl = row.querySelector(`.${CLS.SERVER_NAME}`);
    if (!nameEl) continue;

    const serverName = nameEl.textContent.trim();
    const targetName = targetByLowerName.get(serverName.toLowerCase());
    if (!targetName) continue;

    // Prefer a definitive human-readable aria label. If the upstream adds a
    // new phrase, UNKNOWN deliberately falls through to the CSS signal.
    const ariaLabel = nameEl.getAttribute('aria-label') ?? '';
    if (ariaLabel) {
      const status = resolveStatusFromAriaLabel(ariaLabel);
      logger.log?.(`[serverStatus] ${targetName}: "${ariaLabel}" → ${status}`);
      if (status !== STATUS.UNKNOWN) {
        statusMap.set(targetName, status);
        continue;
      }
    }

    // The inner status element owns the modifier. Selecting the base class
    // token excludes the similarly named "-wrapper" element.
    const statusEl = row.querySelector(`.${CLS.STATUS_DIV}`);
    if (statusEl) {
      const status = resolveStatusFromClass(statusEl.className);
      logger.log?.(`[serverStatus] ${targetName}: class → ${status}`);
      if (status !== STATUS.UNKNOWN) statusMap.set(targetName, status);
    }
  }

  // Some page variants expose only aria-label nodes, outside the normal row.
  const ariaNodes = document.querySelectorAll('[aria-label]');
  for (const target of serverNames) {
    if (statusMap.has(target)) continue;

    for (const node of ariaNodes) {
      const label = node.getAttribute('aria-label') ?? '';
      if (!label.toLowerCase().startsWith(target.toLowerCase())) continue;

      const status = resolveStatusFromAriaLabel(label);
      logger.log?.(`[serverStatus] ${target}: fallback → ${status}`);
      if (status !== STATUS.UNKNOWN) {
        statusMap.set(target, status);
        break;
      }
    }
  }

  for (const target of serverNames) {
    if (!statusMap.has(target)) {
      logger.error?.(`[serverStatus] Could not find "${target}" on the status page.`);
      statusMap.set(target, STATUS.UNKNOWN);
    }
  }

  return statusMap;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch the status page once and return statuses for multiple servers.
 * A single request keeps the configured server checks consistent.
 *
 * @param {string[]} serverNames - Server names to check
 * @returns {Promise<Map<string, string>>} Map of server name → STATUS
 * @throws  When the HTTP request itself fails
 */
export async function getMultiServerStatus(serverNames) {
  // ── 1. Fetch page (single request for all servers) ────────────────────────
  let html;
  try {
    const response = await fetch(config.statusUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    html = await response.text();
  } catch (err) {
    throw new Error(`Failed to fetch server status page: ${err.message}`);
  }

  return parseServerStatuses(html, serverNames);
}
