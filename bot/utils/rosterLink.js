/**
 * rosterLink.js
 *
 * Centralised URL builders for the character-page click-through links
 * that LoaLogs embeds render. Every display surface (list view, search
 * card, broadcasts, evidence detail, trust card) should call into one
 * of these helpers instead of building the URL inline.
 *
 * Why a helper layer:
 *   1. Config-driven base. `config.bibleBaseUrl` controls all four
 *      shapes from one env var; swapping the upstream roster site no
 *      longer means grepping 25+ files for `lostark.bible`.
 *   2. Single encoding rule. Character names occasionally carry chars
 *      that need percent-encoding; centralising prevents one site from
 *      double-encoding or skipping it.
 *   3. Future "no link" mode. If/when LoaLogs is fully decoupled from
 *      bible and no public roster site is available, returning empty
 *      string here lets renderers fall back to plain text without
 *      losing all calling code.
 *
 * NOT covered by this module:
 *   - Data-API URLs (`__data.json`, `/guild/__data.json`). Those are
 *     bible-as-data-source, controlled by the scraper/worker layer.
 *     Decoupling those requires a different upstream entirely (the
 *     local-sync browser companion project).
 */

import config from '../config.js';

function joinBase(suffix) {
  // config.bibleBaseUrl already has trailing slashes trimmed at load time.
  return `${config.bibleBaseUrl}/${suffix}`;
}

/** Roster page link · `<base>/<name>/roster`. The most-used shape. */
export function rosterUrl(name) {
  return joinBase(`${encodeURIComponent(name)}/roster`);
}

/** Logs page link · `<base>/<name>/logs`. Used by /la-list add success card. */
export function logsUrl(name) {
  return joinBase(`${encodeURIComponent(name)}/logs`);
}

/** Bare profile link · `<base>/<name>`. Used by hidden-roster embeds. */
export function profileUrl(name) {
  return joinBase(encodeURIComponent(name));
}

/** Guild page link · `<base>/<name>/guild`. Used by guild-members card. */
export function guildPageUrl(name) {
  return joinBase(`${encodeURIComponent(name)}/guild`);
}
