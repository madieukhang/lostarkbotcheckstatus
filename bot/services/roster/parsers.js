import { getClassName } from '../../models/Class.js';

export function parseItemLevelValue(value) {
  const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
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

export function extractRosterClassMapFromHtml(html) {
  const rosterClassMap = new Map();
  const regex = /name:\"([^\"]+)\",class:\"([^\"]+)\"/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, charName, clsId] = match;
    if (!charName || !clsId) continue;
    rosterClassMap.set(charName, clsId);
  }

  return rosterClassMap;
}

export async function parseRosterCharactersFromHtml(html, document) {
  const rosterClassMap = extractRosterClassMapFromHtml(html);
  const characters = [];
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

  return characters;
}

export function parseCharacterMetaFromHtml(html) {
  const rlMatch = html.match(/rosterLevel:(\d+)/);
  const shMatch = html.match(/stronghold:\{[^}]*level:(\d+),name:"([^"]+)"\}/);
  const guildMatch = html.match(/guild:\{name:"([^"]+)",grade:"([^"]+)"\}/);
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
