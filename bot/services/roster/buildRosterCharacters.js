/**
 * services/roster/buildRosterCharacters.js
 * One-shot roster fetcher used by /la-list add + multiadd. Parses the
 * bible roster page and falls back to hidden-roster inference (search
 * API) when the page is gated. Returns a normalised shape with all
 * possible failure reasons surfaced as `failReason` so the caller
 * can render a single embed without try/catch sprawl.
 */

import { JSDOM } from 'jsdom';
import { normalizeNameKey } from '../../utils/names.js';

import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { inferHiddenRosterItemLevel } from './search.js';
import { createRosterVirtualConsole } from './dom.js';
import { parseCharacterMetaFromHtml, parseItemLevelValue, parseRosterCharactersFromHtml } from './parsers.js';

const virtualConsole = createRosterVirtualConsole();

// Bible answers 404 for a name it does not know, so that status means no
// roster rather than a failed request.
const FAILED_BIBLE_STATUS_REASONS = Object.freeze({
  404: null,
  429: 'Rate limited - try again later',
});

function describeFailedBibleStatus(status) {
  return Object.hasOwn(FAILED_BIBLE_STATUS_REASONS, status)
    ? FAILED_BIBLE_STATUS_REASONS[status]
    : `HTTP ${status}`;
}

/**
 * Whether one `onMetaFetchResult` request result is a Bible failure: a thrown
 * error, or a non-ok status other than the 404 Bible answers for an unknown name.
 * @param {{ok?: boolean, status?: number, error?: Error}} result - one request attempt
 * @returns {boolean}
 */
export function isBibleRequestFailure({ ok, status, error }) {
  return Boolean(error) || (!ok && describeFailedBibleStatus(status) !== null);
}

function describeFetchError(err) {
  return err?.name === 'TimeoutError' ? 'timeout' : err?.message || String(err);
}

export function stampRosterWorld(characters, world) {
  const normalizedWorld = String(world || '').trim();
  return normalizedWorld
    ? characters.map((character) => ({ ...character, world: normalizedWorld }))
    : characters;
}

function readTargetStats(targetRecord) {
  const parsedItemLevel = parseItemLevelValue(targetRecord?.itemLevel);
  return {
    itemLevel: parsedItemLevel > 0 ? parsedItemLevel : null,
    combatScore: targetRecord?.combatScore && targetRecord.combatScore !== '?'
      ? targetRecord.combatScore
      : null,
    className: targetRecord?.className || null,
  };
}

// Builds of one roster that overlap (two users checking one name) share one
// fetch. Separate fetches would queue in the worker's one-at-a-time line,
// where the second can time out and fall back to a slower route with a
// thinner result.
const inFlightRosterBuilds = new Map();

// Options that are all plain values can be shared; a signal or callback
// belongs to one caller, so that caller gets its own fetch.
function rosterBuildShareKey(name, options) {
  const entries = Object.entries(options).sort(([a], [b]) => a.localeCompare(b));
  const callerOwned = entries.some(([, value]) => typeof value === 'function' || (value !== null && typeof value === 'object'));
  return callerOwned ? null : JSON.stringify([String(name).trim().normalize('NFC'), entries]);
}

/**
 * Resolve a character's roster (siblings) via lostark.bible. Tries the
 * direct roster page first, then falls back to hidden-roster
 * inference. Always returns a result object (never throws) so callers
 * don't have to wrap. Overlapping calls with the same name and plain
 * options share one fetch; each caller gets its own copy of the result.
 * @param {string} name - target character name
 * @param {object} [options]
 * @param {boolean} [options.hiddenRosterFallback=false]
 * @param {boolean} [options.viaWorker] - forwarded to bibleClient
 * @returns {Promise<{allCharacters: string[], hasValidRoster: boolean, failReason: string|null, targetItemLevel: number|null, targetClassName: string|null, targetCombatScore: number|null, rosterVisibility: string, rosterCharacters: object[]}>}
 */
export async function buildRosterCharacters(name, options = {}) {
  const key = rosterBuildShareKey(name, options);
  if (key === null) return buildRosterCharactersOnce(name, options);
  let shared = inFlightRosterBuilds.get(key);
  if (!shared) {
    shared = buildRosterCharactersOnce(name, options).finally(() => {
      if (inFlightRosterBuilds.get(key) === shared) inFlightRosterBuilds.delete(key);
    });
    inFlightRosterBuilds.set(key, shared);
  }
  return structuredClone(await shared);
}

async function buildRosterCharactersOnce(name, options) {
  const { hiddenRosterFallback = false } = options;
  const fetchOptions = buildBibleFetchOptions(options);

  let allCharacters = [name];
  let hasValidRoster = false;
  let failReason = null;
  let targetItemLevel = null;
  let targetClassName = null;
  let targetCombatScore = null;
  let rosterVisibility = 'missing';
  let rosterCharacters = [];

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await bibleClient.fetch(targetUrl, fetchOptions);

    if (!response.ok) {
      failReason = describeFailedBibleStatus(response.status);
    } else {
      const html = await response.text();
      const { document } = new JSDOM(html, { virtualConsole }).window;

      // Use the canonical parser that /la-roster also uses. It returns
      // per-character records with name + itemLevel + combatScore +
      // classId + className already resolved.
      // The server is a property of the roster, not of each character, so
      // it is read once and stamped onto every record · that is the shape
      // upsertRosterSnapshots stores and every card reads back.
      const world = parseCharacterMetaFromHtml(html)?.world || '';
      const rosterChars = stampRosterWorld(
        await parseRosterCharactersFromHtml(html, document),
        world
      );
      rosterCharacters = rosterChars;

      // Find the queried character's record in the parsed list. Match
      // is case-insensitive because OCR'd / user-typed names may not
      // match bible's capitalisation exactly.
      const targetKey = normalizeNameKey(name);
      const targetRecord = rosterChars.find(
        (character) => normalizeNameKey(character.name) === targetKey
      );
      if (targetRecord) {
        const targetStats = readTargetStats(targetRecord);
        targetItemLevel = targetStats.itemLevel;
        targetCombatScore = targetStats.combatScore;
        targetClassName = targetStats.className;
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        rosterVisibility = 'visible';
        // Dedup by name string so two same-named entries (rare on
        // bible) collapse to one.
        allCharacters = [...new Set(rosterChars.map((c) => c.name))];
      } else if (hiddenRosterFallback) {
        // fetchCharacterMeta returns null both for an unknown name and for a
        // failed read; its per-request results tell the two apart.
        let metaFailure = null;
        const meta = await fetchCharacterMeta(name, {
          ...options,
          onMetaFetchResult: (result) => {
            options.onMetaFetchResult?.(result);
            if (!isBibleRequestFailure(result)) metaFailure = null;
            else metaFailure = result.error ? describeFetchError(result.error) : describeFailedBibleStatus(result.status);
          },
        });
        if (!meta) failReason = metaFailure;
        if (meta) {
          hasValidRoster = true;
          rosterVisibility = 'hidden';
          targetItemLevel = meta.itemLevel ?? await inferHiddenRosterItemLevel(name, options);
          allCharacters = [name];
          rosterCharacters = [{
            name,
            classId: meta.classId || '',
            itemLevel: targetItemLevel || 0,
            combatScore: '',
          }];

          rosterCharacters = stampRosterWorld(rosterCharacters, meta.world);
        }
      }
    }
  } catch (err) {
    failReason = describeFetchError(err);
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return {
    hasValidRoster,
    allCharacters,
    failReason,
    targetItemLevel,
    targetClassName,
    targetCombatScore,
    rosterVisibility,
    rosterCharacters,
  };
}
