import { createArtistEmbed } from '../../utils/artistVoice.js';

import { getClassName, getClassEmoji } from '../../models/Class.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { formatLinkedCharacter } from '../list/trackedAltsRender.js';
import { COLORS } from '../../utils/ui.js';
import { t } from '../../services/i18n/index.js';
import { hasDatabaseListMatch } from '../../services/list-check/verification.js';
import { pickEvidenceEntry } from './evidence.js';

export function buildSearchResultEmbed({ name, results, minIlvl, maxIlvl, classFilter, lang = 'en', snapshotMap = new Map() }) {
  const lines = results.map((result, index) => {
    const cls = getClassName(result.cls);
    const classPrefix = getClassEmoji(cls) || cls;
    const ilvl = Number(result.itemLevel || 0).toFixed(2);
    // CP comes through from the snapshot enrichment that search/index
    // attaches when available; falsy when the name has never been
    // queried via /la-roster (graceful skip · the row still carries
    // class icon + ilvl).
    const cpSuffix = result.combatScore ? ` · \`${result.combatScore} CP\`` : '';
    const hasImage = Boolean(pickEvidenceEntry(result));

    let icon = '';
    if (result.black) icon += '⛔';
    if (result.white) icon += '✅';
    if (result.watch) icon += '⚠️';
    if (result.trusted) icon += '🛡️';
    if (icon) icon += ' ';

    const link = `[${result.name}](${rosterUrl(result.name)})`;
    // Class icon (or text fallback) sits BEFORE the name, after the list-
    // status icon. Pattern matches the rest of the v0.5.67 vocabulary.
    let line = `**${index + 1}.** ${icon}${classPrefix} ${link} · \`${ilvl}\`${cpSuffix}${hasImage ? ' · 📎' : ''}`;

    for (const entry of [result.black, result.white, result.watch]) {
      if (!entry) continue;
      const isRosterMatch = entry.name.toLowerCase() !== result.name.toLowerCase();
      // The matched entry is a character in its own right · render it the
      // way every other character on this card is rendered instead of as
      // bare bold text.
      const via = isRosterMatch
        ? t('dialogue.search.via', lang, {
          name: formatLinkedCharacter(entry.name, snapshotMap.get(entry.name.toLowerCase())),
        })
        : '';
      line += `\n    ↳ ${via}*${entry.reason || t('dialogue.search.noReason', lang)}*`;
      if (entry.raid) line += ` \`${entry.raid}\``;
    }

    return line;
  });

  const blackCount = results.filter((result) => result.black).length;
  const watchCount = results.filter((result) => result.watch).length;
  const whiteCount = results.filter((result) => result.white).length;
  const trustedCount = results.filter((result) => result.trusted).length;
  const notListedCount = results.filter((result) => !hasDatabaseListMatch(result)).length;
  const hasBlack = blackCount > 0;
  const hasWatch = watchCount > 0;
  const hasWhite = whiteCount > 0;
  const color = hasBlack ? COLORS.danger : hasWatch ? COLORS.warning : hasWhite ? COLORS.success : COLORS.info;

  const filterParts = [`ilvl ≥ ${minIlvl}`];
  if (maxIlvl !== null) filterParts.push(`ilvl ≤ ${maxIlvl}`);
  if (classFilter) filterParts.push(getClassName(classFilter));

  const breakdown = [];
  if (hasBlack) breakdown.push(`⛔ **${blackCount}**`);
  if (hasWatch) breakdown.push(`⚠️ **${watchCount}**`);
  if (hasWhite) breakdown.push(`✅ **${whiteCount}**`);
  if (trustedCount > 0) breakdown.push(`🛡️ **${trustedCount}**`);
  if (notListedCount > 0) {
    breakdown.push(`❓ **${notListedCount}** ${t('dialogue.search.notListed', lang)}`);
  }
  const matchWord = t(`dialogue.search.${results.length === 1 ? 'matchOne' : 'matchMany'}`, lang);
  const summaryLine = breakdown.length > 0
    ? t('dialogue.search.summary', lang, { count: results.length, word: matchWord, breakdown: breakdown.join(' · ') })
    : t('dialogue.search.summaryPlain', lang, { count: results.length, word: matchWord });

  const description = `${summaryLine}\n\n${lines.join('\n')}`.slice(0, 4096);

  return createArtistEmbed(lang)
    .setTitle(`🔍 ${t('dialogue.search.title', lang, { name })}`)
    .setDescription(description)
    .setColor(color)
    .setFooter({
      text: t('dialogue.search.footer', lang, { filters: filterParts.join(' · ') }),
    })
    .setTimestamp();
}
