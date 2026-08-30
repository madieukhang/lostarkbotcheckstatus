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

    const statusIcons = [
      result.black ? '⛔' : '',
      result.white ? '✅' : '',
      result.watch ? '⚠️' : '',
      result.trusted ? '🛡️' : '',
    ].filter(Boolean).join('');
    const icon = statusIcons ? `${statusIcons} ` : '';

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
      const raidSuffix = entry.raid ? ` \`${entry.raid}\`` : '';
      line += `\n    ↳ ${via}*${entry.reason || t('dialogue.search.noReason', lang)}*${raidSuffix}`;
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

  const filterParts = [
    `ilvl ≥ ${minIlvl}`,
    maxIlvl !== null ? `ilvl ≤ ${maxIlvl}` : '',
    classFilter ? getClassName(classFilter) : '',
  ].filter(Boolean);

  const breakdown = [
    hasBlack ? `⛔ **${blackCount}**` : '',
    hasWatch ? `⚠️ **${watchCount}**` : '',
    hasWhite ? `✅ **${whiteCount}**` : '',
    trustedCount > 0 ? `🛡️ **${trustedCount}**` : '',
    notListedCount > 0
      ? `❓ **${notListedCount}** ${t('dialogue.search.notListed', lang)}`
      : '',
  ].filter(Boolean);
  const matchWord = t(`dialogue.search.${results.length === 1 ? 'matchOne' : 'matchMany'}`, lang);

  // The count lives in the title, the way every other list card carries
  // its total. The breakdown line only earns its space once there is
  // more than one result · with a single hit it restates the icon
  // sitting on the row right below it.
  const description = results.length > 1 && breakdown.length > 0
    ? `${breakdown.join(' · ')}\n\n${lines.join('\n')}`.slice(0, 4096)
    : lines.join('\n').slice(0, 4096);

  return createArtistEmbed(lang)
    .setTitle(`🔍 ${t('dialogue.search.title', lang, { name })} · ${results.length} ${matchWord}`)
    .setDescription(description)
    .setColor(color)
    .setFooter({
      text: t('dialogue.search.footer', lang, { filters: filterParts.join(' · ') }),
    });
}
