import { connectDB } from '../../db.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import TrustedUser from '../../models/TrustedUser.js';
import UserPreference from '../../models/UserPreference.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName, resolveClassId } from '../../models/Class.js';
import { fetchNameSuggestions } from '../../services/roster/index.js';
import { getUserLanguage } from '../../services/i18n/index.js';
import { normalizeCharacterName } from '../../utils/names.js';
import {
  attachSearchEvidenceCollector,
  buildSearchEvidenceComponents,
  getFlaggedResultsWithImages,
} from './evidence.js';
import { buildEntryMap, sortBlacklistForScopePriority } from './matches.js';
import { buildSearchResultEmbed } from './ui.js';

export async function handleSearchCommand(interaction) {
  const raw = interaction.options.getString('name', true);
  const name = normalizeCharacterName(raw);
  const minIlvl = interaction.options.getInteger('min_ilvl') ?? 1700;
  const maxIlvl = interaction.options.getInteger('max_ilvl') ?? null;
  const classFilter = resolveClassId(interaction.options.getString('class'));

  await interaction.deferReply();

  try {
    let suggestions = await fetchNameSuggestions(name);

    if (suggestions === null) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Bible Unavailable',
          description: 'lostark.bible is currently unavailable. Please try again later.',
        })],
      });
      return;
    }

    if (suggestions.length === 0) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'No Results',
          description: `No characters matching **${name}** were found.`,
        })],
      });
      return;
    }

    suggestions = suggestions.filter((s) => {
      const ilvl = Number(s.itemLevel || 0);
      if (ilvl < minIlvl) return false;
      if (maxIlvl !== null && ilvl > maxIlvl) return false;
      if (classFilter && s.cls !== classFilter) return false;
      return true;
    });

    if (suggestions.length === 0) {
      const filterDesc = [`ilvl ≥ ${minIlvl}`];
      if (maxIlvl !== null) filterDesc.push(`ilvl ≤ ${maxIlvl}`);
      if (classFilter) filterDesc.push(`class: ${getClassName(classFilter)}`);
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'No Results With Filters',
          description: `No characters matching **${name}** with the applied filters.`,
          fields: [{ name: 'Filters', value: filterDesc.join(', '), inline: false }],
        })],
      });
      return;
    }

    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    const searchGuildId = interaction.guild?.id || '';
    const sliced = suggestions.slice(0, 15);
    const allNames = sliced.map((s) => s.name);
    const collation = { locale: 'en', strength: 2 };
    const nameQuery = { $or: [{ name: { $in: allNames } }, { allCharacters: { $in: allNames } }] };
    const blackQuery = buildBlacklistQuery(nameQuery, searchGuildId);

    const [allBlack, allWhite, allWatch, allTrusted, allSnapshots] = await Promise.all([
      Blacklist.find(blackQuery).collation(collation).lean(),
      Whitelist.find(nameQuery).collation(collation).lean(),
      Watchlist.find(nameQuery).collation(collation).lean(),
      TrustedUser.find({ name: { $in: allNames } }).collation(collation).lean(),
      RosterSnapshot.find({ name: { $in: allNames } }).collation(collation).lean(),
    ]);

    const blackMap = buildEntryMap(sortBlacklistForScopePriority(allBlack));
    const whiteMap = buildEntryMap(allWhite);
    const watchMap = buildEntryMap(allWatch);
    const trustedMap = new Map(allTrusted.map((t) => [t.name.toLowerCase(), t]));
    // Snapshot enrichment surfaces combatScore + a fresher itemLevel
    // from the last /la-roster run on each name. Bible suggestions
    // already carry name/cls/itemLevel but no CP, so the snapshot is
    // strictly additive when present.
    const snapshotMap = new Map(allSnapshots.map((s) => [s.name.toLowerCase(), s]));

    const results = sliced.map((s) => {
      const snap = snapshotMap.get(s.name.toLowerCase()) || null;
      const snapItemLevel = Number(snap?.itemLevel || 0);
      return {
        ...s,
        itemLevel: snapItemLevel > 0 ? snapItemLevel : s.itemLevel,
        black: blackMap.get(s.name.toLowerCase()) || null,
        white: whiteMap.get(s.name.toLowerCase()) || null,
        watch: watchMap.get(s.name.toLowerCase()) || null,
        trusted: trustedMap.get(s.name.toLowerCase()) || null,
        combatScore: snap?.combatScore || '',
      };
    });

    const embed = buildSearchResultEmbed({ name, results, minIlvl, maxIlvl, classFilter });

    // Build evidence dropdown for flagged entries with images (rehosted OR legacy)
    const flaggedWithImages = getFlaggedResultsWithImages(results);
    const components = buildSearchEvidenceComponents(flaggedWithImages, lang);

    await interaction.editReply({ embeds: [embed], components });
    await attachSearchEvidenceCollector({ interaction, results, flaggedWithImages, lang });
  } catch (err) {
    console.error('[search] ❌ Search failed:', err.message);
    await interaction.editReply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Search Failed',
        description: 'Could not run the name search.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      })],
    });
  }
}
