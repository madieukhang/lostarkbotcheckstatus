import { normalizeNameKey } from '../../utils/names.js';

/**
 * Whether enrichment changed the identity supplied by OCR or typed input.
 * Case-only canonicalization is intentionally ignored: it does not point to
 * a different list entry and would add noise to the confirmation card.
 */
export function didListCheckNameChange(item) {
  const inputName = normalizeNameKey(item?.inputName);
  const finalName = normalizeNameKey(item?.name);
  return Boolean(inputName && finalName && inputName !== finalName);
}

/**
 * Build the final identities that are allowed to confirm a list hit.
 * The enriched/canonical name wins; visible-roster siblings are fallbacks.
 */
export function buildListMatchCandidates(item) {
  const candidates = [];
  const seen = new Set();

  function add(name, origin) {
    const clean = String(name || '').trim();
    const key = normalizeNameKey(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({ name: clean, origin });
  }

  add(item?.name, 'checked');
  for (const alt of (Array.isArray(item?.discoveredAlts) ? item.discoveredAlts : [])) {
    add(alt, 'roster');
  }
  return candidates;
}

/**
 * Resolve one list against the final candidates and retain how the match was
 * established so the Discord card can make the confirmation auditable.
 */
export function resolveMappedListMatch(map, candidates) {
  for (const candidate of candidates || []) {
    const entry = map?.get(normalizeNameKey(candidate?.name));
    if (!entry) continue;

    const matchedName = String(candidate.name || '').trim();
    let kind = 'tracked';
    if (candidate.origin === 'roster') kind = 'roster';
    else if (normalizeNameKey(entry.name) === normalizeNameKey(matchedName)) kind = 'direct';

    return {
      entry,
      detail: { kind, matchedName },
    };
  }
  return { entry: null, detail: null };
}
