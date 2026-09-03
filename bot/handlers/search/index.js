import { connectDB } from '../../db.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../utils/interactionReplies.js';
import UserPreference from '../../models/UserPreference.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName, resolveClassId } from '../../models/Class.js';
import {
  createNameSuggestionContext,
  fetchNameSuggestions,
} from '../../services/roster/index.js';
import {
  LIST_LOOKUP_COLLATION,
  loadListLookup,
} from '../../services/list-check/lookup.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import {
  buildNameKeyMap,
  normalizeCharacterName,
  normalizeNameKey,
} from '../../utils/names.js';
import {
  attachSearchEvidenceCollector,
  buildSearchEvidenceComponents,
  getFlaggedResultsWithImages,
} from './evidence.js';
import { buildSearchResultEmbed } from './ui.js';

export function filterSearchSuggestions(suggestions, { minIlvl, maxIlvl, classFilter }) {
  const filtered = [];
  const seen = new Set();
  for (const suggestion of suggestions || []) {
    const key = normalizeNameKey(suggestion?.name);
    const ilvl = Number(suggestion?.itemLevel || 0);
    const matches = key
      && ilvl >= minIlvl
      && (maxIlvl === null || ilvl <= maxIlvl)
      && (!classFilter || suggestion.cls === classFilter);
    if (!matches || seen.has(key)) continue;
    seen.add(key);
    filtered.push(suggestion);
  }
  return filtered;
}

export function collectMissingSearchSnapshotNames(maps, names, snapshotMap) {
  const missing = new Map();
  for (const rawName of names) {
    const resultKey = normalizeNameKey(rawName);
    for (const map of [maps.black, maps.white, maps.watch]) {
      const entry = map.get(resultKey);
      if (!entry) continue;
      const name = String(entry?.name || '').trim().normalize('NFC');
      const key = normalizeNameKey(name);
      if (key && !snapshotMap.has(key) && !missing.has(key)) missing.set(key, name);
    }
  }
  return [...missing.values()];
}

export async function handleSearchCommand(interaction) {
  const startedAt = Date.now();
  const suggestionContext = createNameSuggestionContext({ maxNetworkLookups: 1 });
  let status = 'error';
  let bibleMs = 0;
  let dbMs = 0;
  let resultCount = 0;
  const raw = interaction.options.getString('name', true);
  const name = normalizeCharacterName(raw);
  const minIlvl = interaction.options.getInteger('min_ilvl') ?? 1700;
  const maxIlvl = interaction.options.getInteger('max_ilvl') ?? null;
  const classFilter = resolveClassId(interaction.options.getString('class'));

  await deferReply(interaction);
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

  try {
    const bibleStartedAt = Date.now();
    let suggestions = await fetchNameSuggestions(name, { suggestionContext });
    bibleMs = Date.now() - bibleStartedAt;

    if (suggestions === null) {
      status = 'bible-unavailable';
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.search.bibleUnavailable', lang),
        lang,
      });
      return;
    }

    if (suggestions.length === 0) {
      status = 'no-results';
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.search.noResults', lang, { name }),
        lang,
      });
      return;
    }

    suggestions = filterSearchSuggestions(suggestions, { minIlvl, maxIlvl, classFilter });

    if (suggestions.length === 0) {
      status = 'filtered-empty';
      const filterDesc = [
        `ilvl ≥ ${minIlvl}`,
        maxIlvl !== null ? `ilvl ≤ ${maxIlvl}` : '',
        classFilter ? `class: ${getClassName(classFilter)}` : '',
      ].filter(Boolean);
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.search.noFilteredResults', lang, { name }),
        fields: [{ name: t('dialogue.search.noFilteredResults.filters', lang), value: filterDesc.join(', '), inline: false }],
        lang,
      });
      return;
    }

    const dbStartedAt = Date.now();
    await connectDB();

    const searchGuildId = interaction.guild?.id || '';
    const sliced = suggestions.slice(0, 15);
    const allNames = sliced.map((s) => s.name);

    const [lookup, allSnapshots] = await Promise.all([
      loadListLookup(allNames, { guildId: searchGuildId }),
      RosterSnapshot.find({ name: { $in: allNames } })
        .collation(LIST_LOOKUP_COLLATION)
        .lean(),
    ]);
    dbMs = Date.now() - dbStartedAt;

    // Snapshot enrichment surfaces combatScore + a fresher itemLevel
    // from the last /la-roster run on each name. Bible suggestions
    // already carry name/cls/itemLevel but no CP, so the snapshot is
    // strictly additive when present.
    const snapshotMap = buildNameKeyMap(allSnapshots);
    // A roster match names an entry the search term did not, and that
    // name gets rendered too · without its snapshot it would show as
    // bare text beside rows that carry a class icon and a roster link.
    const viaNames = collectMissingSearchSnapshotNames(lookup.maps, allNames, snapshotMap);
    if (viaNames.length > 0) {
      try {
        const viaSnapshots = await RosterSnapshot.find({ name: { $in: viaNames } })
          .collation(LIST_LOOKUP_COLLATION)
          .lean();
        for (const snapshot of viaSnapshots) {
          snapshotMap.set(normalizeNameKey(snapshot.name), snapshot);
        }
      } catch (err) {
        console.warn('[search] Snapshot lookup for matched entries failed (non-fatal):', err.message);
      }
    }

    const results = sliced.map((s) => {
      const key = normalizeNameKey(s.name);
      const snap = snapshotMap.get(key) || null;
      const snapItemLevel = Number(snap?.itemLevel || 0);
      return {
        ...s,
        identityVerified: true,
        identityVerificationSource: 'bible-search',
        itemLevel: snapItemLevel > 0 ? snapItemLevel : s.itemLevel,
        black: lookup.maps.black.get(key) || null,
        white: lookup.maps.white.get(key) || null,
        watch: lookup.maps.watch.get(key) || null,
        trusted: lookup.maps.trusted.get(key) || null,
        combatScore: snap?.combatScore || '',
      };
    });
    resultCount = results.length;

    const embed = buildSearchResultEmbed({ name, results, minIlvl, maxIlvl, classFilter, lang, snapshotMap });

    // Build evidence dropdown for flagged entries with images (rehosted OR legacy)
    const flaggedWithImages = getFlaggedResultsWithImages(results);
    const components = buildSearchEvidenceComponents(flaggedWithImages, lang);

    await editEmbed(interaction, embed, { components });
    await attachSearchEvidenceCollector({ interaction, results, flaggedWithImages, lang });
    status = 'ok';
  } catch (err) {
    console.error('[search] ❌ Search failed:', err.message);
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.search.failed', lang),
      fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
      lang,
    });
  } finally {
    const stats = suggestionContext.stats;
    console.log([
      `[search] Timing total=${Date.now() - startedAt}ms`,
      `status=${status}`,
      `bible=${bibleMs}ms`,
      `db=${dbMs}ms`,
      `results=${resultCount}`,
      `network=${stats.networkLookups}`,
      `sharedCache=${stats.sharedCacheHits}`,
    ].join(' '));
  }
}
