/**
 * serverStatus.js
 * Fetches and parses the Lost Ark server status page to determine
 * the current status of a target server (e.g. "Brelshaza").
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
 *    <div aria-label="Brelshaza is online"
 *         class="ags-ServerStatus-content-responses-response-server-name">
 *      Brelshaza
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
import config from './config.js';

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
  const cls = className.toLowerCase();
  if (cls.includes('--good') || cls.includes('--busy') || cls.includes('--full')) {
    return STATUS.ONLINE;
  }
  if (cls.includes('--maintenance')) {
    return STATUS.MAINTENANCE;
  }
  // No recognised modifier → offline
  return STATUS.OFFLINE;
}

/**
 * Determine status from the aria-label attribute on the server name element.
 * The live page uses labels like "Brelshaza is online" / "Brelshaza is offline".
 * This is the most reliable signal because it is human-readable plain text.
 *
 * @param {string} ariaLabel
 * @returns {string}
 */
function resolveStatusFromAriaLabel(ariaLabel) {
  const label = ariaLabel.toLowerCase();
  if (label.includes('online'))      return STATUS.ONLINE;
  if (label.includes('maintenance')) return STATUS.MAINTENANCE;
  if (label.includes('offline'))     return STATUS.OFFLINE;
  return STATUS.UNKNOWN;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch the Lost Ark server status page and return the normalised status for
 * the configured target server.
 *
 * Parsing uses three strategies in order of reliability:
 *   1. aria-label on the server name element   e.g. "Brelshaza is online"
 *   2. CSS modifier class on the inner status div  e.g. "…--good"
 *   3. Page-wide aria-label attribute search (fallback if outer DOM shifts)
 *
 * @returns {Promise<string>} One of the STATUS constants
 * @throws  When the HTTP request itself fails
 */
export async function getServerStatus() {
  // ── 1. Fetch page ───────────────────────────────────────────────────────────
  let html;
  try {
    const response = await fetch(config.statusUrl, {
      headers: {
        // Some CDNs block requests without a User-Agent header
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

  // ── 2. Parse HTML ───────────────────────────────────────────────────────────
  const { document } = new JSDOM(html).window;

  // ── 3. Primary strategy: walk known server row elements ─────────────────────
  // Each server appears in a <div class="ags-ServerStatus-…-server"> row.
  const serverRows = document.querySelectorAll(`.${CLS.SERVER_ROW}`);

  for (const row of serverRows) {
    // ── 3a. Locate the name element and confirm it matches our target ──────
    const nameEl = row.querySelector(`.${CLS.SERVER_NAME}`);
    if (!nameEl) continue;

    const serverName = nameEl.textContent.trim();
    if (serverName !== config.targetServer) continue;

    // ── 3b. Primary source: aria-label ("Brelshaza is online") ───────────
    // This is the most semantically stable value on the page.
    const ariaLabel = nameEl.getAttribute('aria-label') ?? '';
    if (ariaLabel) {
      const status = resolveStatusFromAriaLabel(ariaLabel);
      console.log(`[serverStatus] Resolved via aria-label: "${ariaLabel}" → ${status}`);
      return status;
    }

    // ── 3c. Secondary source: CSS modifier on the inner status div ────────
    // querySelectorAll returns DOM-order results; the wrapper comes before the
    // inner div but its class NEVER contains '--', so we skip it safely.
    const statusEls = row.querySelectorAll(`[class*="${CLS.STATUS_DIV}"]`);
    for (const el of statusEls) {
      // Only the inner div has a modifier suffix like --good or --maintenance.
      // The wrapper ends with "-wrapper" and contains no '--' modifier.
      if (!el.className.includes('--')) continue;

      const status = resolveStatusFromClass(el.className);
      console.log(`[serverStatus] Resolved via class modifier: "${el.className}" → ${status}`);
      return status;
    }
  }

  // ── 4. Fallback strategy: page-wide aria-label search ───────────────────────
  // Catches cases where the outer class name structure changes but aria labels remain.
  const ariaNodes = document.querySelectorAll(`[aria-label*="${config.targetServer}"]`);
  for (const node of ariaNodes) {
    const label = node.getAttribute('aria-label') ?? '';
    if (label.toLowerCase().startsWith(config.targetServer.toLowerCase())) {
      const status = resolveStatusFromAriaLabel(label);
      console.log(`[serverStatus] Resolved via fallback aria-label: "${label}" → ${status}`);
      return status;
    }
  }

  // ── 5. Give up ───────────────────────────────────────────────────────────────
  console.error(
    `[serverStatus] Could not find "${config.targetServer}" on the status page. ` +
    'The page structure may have changed.'
  );
  return STATUS.UNKNOWN;
}
