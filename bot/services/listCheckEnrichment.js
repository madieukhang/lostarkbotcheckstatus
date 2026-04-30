import config from '../config.js';

function getFlaggedEntry(item) {
  return item?.blackEntry || item?.whiteEntry || item?.watchEntry || null;
}

async function loadEnrichmentDeps() {
  const [
    { default: Blacklist },
    { default: Whitelist },
    { default: Watchlist },
    { detectAltsViaStronghold },
  ] = await Promise.all([
    import('../models/Blacklist.js'),
    import('../models/Whitelist.js'),
    import('../models/Watchlist.js'),
    import('./rosterService.js'),
  ]);

  return { Blacklist, Whitelist, Watchlist, detectAltsViaStronghold };
}

function getModelForItem(item, models) {
  if (item?.blackEntry) return models.Blacklist;
  if (item?.whiteEntry) return models.Whitelist;
  if (item?.watchEntry) return models.Watchlist;
  return null;
}

export function selectFlaggedItemsForEnrichment(results, limit = Number.POSITIVE_INFINITY) {
  const flagged = (results || []).filter((item) => Boolean(getFlaggedEntry(item)));
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : flagged.length;
  return flagged.slice(0, cap);
}

export async function enrichFlaggedListEntries(flaggedItems, { logPrefix = 'listcheck' } = {}) {
  const deps = await loadEnrichmentDeps();

  for (const item of flaggedItems) {
    const listEntry = getFlaggedEntry(item);
    const model = getModelForItem(item, deps);
    if (!listEntry || !model) continue;

    try {
      const altResult = await deps.detectAltsViaStronghold(item.name);
      if (!altResult || altResult.alts.length === 0) continue;

      const newAltNames = altResult.alts.map((a) => a.name);
      const existingAlts = listEntry.allCharacters || [];
      const merged = [...new Set([...existingAlts, item.name, ...newAltNames])];
      if (merged.length <= existingAlts.length) continue;

      await model.updateOne(
        { _id: listEntry._id },
        { $set: { allCharacters: merged } }
      );
      console.log(`[${logPrefix}] Enriched ${listEntry.name} allCharacters: ${existingAlts.length} -> ${merged.length}`);
    } catch (err) {
      console.warn(`[${logPrefix}] Alt enrichment failed for ${item.name}:`, err.message);
    }
  }
}

export function queueFlaggedListEntryEnrichment(
  results,
  { logPrefix = 'listcheck', settings = config } = {}
) {
  const allFlagged = selectFlaggedItemsForEnrichment(results);
  if (allFlagged.length === 0) return { queued: 0, skipped: 0, reason: 'none' };

  if (!settings.listcheckAltEnrichmentEnabled) {
    console.log(
      `[${logPrefix}] Skipping background alt enrichment for ${allFlagged.length} flagged item(s); ` +
      'set LISTCHECK_ALT_ENRICHMENT=true to enable it.'
    );
    return { queued: 0, skipped: allFlagged.length, reason: 'disabled' };
  }

  const flaggedItems = selectFlaggedItemsForEnrichment(
    allFlagged,
    settings.listcheckAltEnrichmentLimit
  );
  if (flaggedItems.length === 0) {
    return { queued: 0, skipped: allFlagged.length, reason: 'limit' };
  }

  enrichFlaggedListEntries(flaggedItems, { logPrefix })
    .catch((err) => console.error(`[${logPrefix}] Background enrichment error:`, err.message));

  return {
    queued: flaggedItems.length,
    skipped: allFlagged.length - flaggedItems.length,
    reason: 'queued',
  };
}
