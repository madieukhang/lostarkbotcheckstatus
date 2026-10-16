import { getClassName } from '../../models/Class.js';
import { normalizeNameKey } from '../../utils/names.js';

export function parseItemLevelValue(value) {
  const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a comma-grouped stat such as an item level for display and storage.
 * Unlike parseItemLevelValue, missing or non-positive input becomes 0 so
 * snapshots and stat badges never hold null.
 * @param {unknown} value - raw value such as "1,712.5" or 1712.5
 * @returns {number} the positive number, or 0
 */
export function parsePositiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function extractCharacterItemLevelFromHtml(html) {
  const patterns = [
    /itemLevel:(\d+(?:\.\d+)?)/,
    /itemLevel:"([\d,.]+)"/,
    /"itemLevel":(\d+(?:\.\d+)?)/,
    /"itemLevel":"([\d,.]+)"/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;

    const itemLevel = parseItemLevelValue(match[1]);
    if (itemLevel !== null) return itemLevel;
  }

  return null;
}

function extractRosterClassMapFromHtml(html) {
  const rosterClassMap = new Map();
  const regex = /name:"([^"]+)",class:"([^"]+)"/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, charName, clsId] = match;
    if (!charName || !clsId) continue;
    rosterClassMap.set(charName, clsId);
  }

  return rosterClassMap;
}

// One character of the page's `roster:[...]` data payload, in the key order
// lostark.bible serialises it. If that order changes, nothing matches and the
// parser falls back to the rendered cards alone.
const ROSTER_PAYLOAD_ENTRY = /\{id:\d+,name:"([^"]+)",class:"([^"]*)",ilvl:([\d.]+),combatPower:(?:null|\{id:\d+,score:([\d.]+)\}),combatPowerIsEstimate:(true|false)/g;

// The cards print item level and CP rounded to two decimals, trailing zeros
// dropped ("1722.5"); payload records are formatted the same way.
function formatPayloadNumber(value) {
  return String(Number(Number(value).toFixed(2)));
}

function extractRosterPayloadFromHtml(html) {
  const start = html.indexOf('roster:[');
  if (start < 0) return [];
  // Entries hold objects but no arrays, so the first ']' closes the list.
  const end = html.indexOf(']', start);
  const payload = html.slice(start, end < 0 ? html.length : end);
  return [...payload.matchAll(ROSTER_PAYLOAD_ENTRY)].map(([, name, classId, ilvl, score, estimate]) => ({
    name,
    itemLevel: formatPayloadNumber(ilvl),
    combatScore: score ? `${estimate === 'true' ? '≈' : ''}${formatPayloadNumber(score)}` : '?',
    classId,
    className: getClassName(classId),
  }));
}

/**
 * Read a roster page's characters: the rendered character cards, plus the
 * characters only the page's data payload lists. lostark.bible renders a
 * card only for characters it updated recently, so an alt not refreshed for
 * a few weeks is in the payload alone; it is inserted by item level, where
 * its card would have been. A page with no cards (a hidden or missing
 * roster) stays empty.
 * @param {string} html - the roster page
 * @param {Document} document - the same page parsed into a DOM
 * @returns {Promise<Array<{name: string, itemLevel: string, combatScore: string, classId: string, className: string}>>}
 *   characters in item level order, highest first
 */
export async function parseRosterCharactersFromHtml(html, document) {
  const rosterClassMap = extractRosterClassMapFromHtml(html);
  const characters = [];
  // The region is pinned to NA on purpose · every fetch path in the bot
  // requests /character/NA/, so the pages this ever sees are NA pages.
  // Worth knowing before changing it: on a page from another region this
  // selector matches nothing, the function returns an empty list, and the
  // caller reads that as "roster hidden" rather than an error. So a
  // non-NA character fails silently, and this line is where it starts.
  const links = document.querySelectorAll('a[href^="/character/NA/"]');

  for (const link of links) {
    const headerDiv = link.querySelector('.text-lg.font-semibold');
    if (!headerDiv) continue;

    const charName = [...headerDiv.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .find((t) => t.length > 0);

    const spans = headerDiv.querySelectorAll('span');
    const itemLevel = spans[0]?.textContent.trim() ?? '?';
    const combatScore = spans[1]?.textContent.trim() ?? '?';
    const classId = charName ? rosterClassMap.get(charName) ?? '' : '';
    const className = getClassName(classId);

    if (charName) characters.push({ name: charName, itemLevel, combatScore, classId, className });
  }
  if (characters.length === 0) return characters;

  const listed = new Set(characters.map((character) => normalizeNameKey(character.name)));
  for (const record of extractRosterPayloadFromHtml(html)) {
    const key = normalizeNameKey(record.name);
    if (listed.has(key)) continue;
    listed.add(key);
    const itemLevel = parseItemLevelValue(record.itemLevel);
    const at = characters.findIndex((character) => parseItemLevelValue(character.itemLevel) < itemLevel);
    characters.splice(at < 0 ? characters.length : at, 0, record);
  }

  return characters;
}

export function parseCharacterMetaFromHtml(html) {
  const rlMatch = html.match(/rosterLevel:(\d+)/);
  const shMatch = html.match(/stronghold:\{[^}]*level:(\d+),name:"([^"]+)"\}/);
  const guildMatch = html.match(/guild:\{name:"([^"]+)",grade:"([^"]+)"\}/);
  // The in-game server. bible calls it `world` and puts it in the same
  // SSR payload as stronghold and guild, right before `class:` · the URL
  // only carries the region (NA / CE), which is a coarser thing.
  const worldMatch = html.match(/world:"([^"]+)"/);
  const itemLevel = extractCharacterItemLevelFromHtml(html);
  let classId = '';
  if (rlMatch) {
    const beforeRL = html.substring(Math.max(0, rlMatch.index - 500), rlMatch.index);
    const classMatch = beforeRL.match(/class:"([^"]+)"/);
    if (classMatch) classId = classMatch[1];
  }
  if (!rlMatch || !shMatch) return null;
  return {
    rosterLevel: parseInt(rlMatch[1], 10),
    strongholdLevel: parseInt(shMatch[1], 10),
    strongholdName: shMatch[2],
    guildName: guildMatch ? guildMatch[1] : null,
    guildGrade: guildMatch ? guildMatch[2] : null,
    world: worldMatch ? worldMatch[1] : null,
    classId,
    itemLevel,
  };
}

export function shapeCharacterMetaFromHeader(header) {
  if (!header || typeof header.rosterLevel !== 'number') return null;
  const stronghold = header.stronghold || {};
  const guild = header.guild || null;
  if (typeof stronghold.level !== 'number' || !stronghold.name) return null;
  return {
    rosterLevel: header.rosterLevel,
    strongholdLevel: stronghold.level,
    strongholdName: stronghold.name,
    guildName: guild?.name ?? null,
    guildGrade: guild?.grade ?? null,
    world: typeof header.world === 'string' ? header.world : null,
    classId: typeof header.class === 'string' ? header.class : '',
    itemLevel: typeof header.ilvl === 'number' ? header.ilvl : null,
  };
}

export function parseGuildMembersFromHtml(html) {
  const memberPattern = /\["([^"]+)","([^"]+)",([\d.]+),"([^"]+)"/g;
  const out = [];
  let m;
  while ((m = memberPattern.exec(html)) !== null) {
    out.push({ name: m[1], cls: m[2], ilvl: parseFloat(m[3]), rank: m[4] });
  }
  return out;
}
