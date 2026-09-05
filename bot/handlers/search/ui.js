import { createArtistEmbed } from '../../utils/artistVoice.js';

import { getClassName } from '../../models/Class.js';
import { formatResultLine } from '../../services/list-check/format.js';
import { COLORS } from '../../utils/ui.js';
import { t } from '../../services/i18n/index.js';
import { hasDatabaseListMatch } from '../../services/list-check/verification.js';
import { normalizeNameKey } from '../../utils/names.js';
import { pickEvidenceEntry } from './evidence.js';

function buildSearchDescription(lines, breakdown, lang) {
  // The richer rows contain several roster links. Fit complete rows instead
  // of cutting through Markdown or silently showing half of the last match.
  for (let visible = lines.length; visible >= 0; visible -= 1) {
    const omitted = lines.length - visible;
    const description = [
      breakdown,
      lines.slice(0, visible).join('\n\n'),
      omitted ? `*${t('dialogue.search.moreResults', lang, { count: omitted })}*` : '',
    ].filter(Boolean).join('\n\n');
    if (description.length <= 4096) return description;
  }
  return '';
}

/**
 * Render search matches with the check-card row layout while retaining search
 * ranking, result counts, filters and evidence markers.
 * @param {object} options - Search results, locale, filters and cached snapshots.
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildSearchResultEmbed({ name, results, minIlvl, maxIlvl, classFilter, lang = 'en', snapshotMap = new Map() }) {
  const relatedClasses = Object.fromEntries([...snapshotMap].map(([key, snapshot]) => [
    normalizeNameKey(key),
    snapshot?.className || (snapshot?.classId ? getClassName(snapshot.classId) : ''),
  ]));
  const lines = results.map((result, index) => {
    // Format individually: OCR may merge same-roster characters and sort by
    // severity, but each search match must remain independently reachable.
    const { line } = formatResultLine({
      name: result.name,
      blackEntry: result.black,
      whiteEntry: result.white,
      watchEntry: result.watch,
      trustedEntry: result.trusted,
      snapClassName: getClassName(result.cls),
      snapItemLevel: Number(result.itemLevel || 0),
      snapCombatScore: result.combatScore,
      relatedClasses,
    }, lang, { linkUnlisted: true });
    const [headline, ...branches] = line.split('\n');
    const number = results.length > 1 ? `**${index + 1}.** ` : '';
    const evidence = pickEvidenceEntry(result) ? ' · 📎' : '';
    return [`${number}${headline}${evidence}`, ...branches].join('\n');
  });

  const blackCount = results.filter((result) => result.black).length;
  const watchCount = results.filter((result) => result.watch).length;
  const whiteCount = results.filter((result) => result.white).length;
  const trustedCount = results.filter((result) => result.trusted).length;
  const notListedCount = results.filter((result) => !hasDatabaseListMatch(result)).length;
  const hasBlack = blackCount > 0;
  const hasWatch = watchCount > 0;
  const hasWhite = whiteCount > 0;
  const color = hasBlack ? COLORS.danger : hasWatch ? COLORS.warning : hasWhite || trustedCount > 0 ? COLORS.success : COLORS.info;

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

  // The count lives in the compact heading, the way every other list card carries
  // its total. The breakdown line only earns its space once there is
  // more than one result · with a single hit it restates the icon
  // sitting on the row right below it.
  const description = buildSearchDescription(
    lines,
    results.length > 1 ? breakdown.join(' · ') : '',
    lang,
  );

  return createArtistEmbed(lang)
    .setAuthor({ name: `🔍 ${t('dialogue.search.title', lang, { name })} · ${results.length} ${matchWord}` })
    .setDescription(description)
    .setColor(color)
    .setFooter({
      text: t('dialogue.search.footer', lang, { filters: filterParts.join(' · ') }),
    });
}
