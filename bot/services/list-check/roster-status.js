const LOOKUP_UNAVAILABLE_PATTERNS = [
  /^HTTP (403|429|500|502|503|504)$/i,
  /^Rate limited/i,
  /^timeout$/i,
  /timed out/i,
  /fetch failed/i,
  /network/i,
  /Worker fetch failed/i,
  /Stronghold lookup service is offline/i,
  /Scraping service overloaded/i,
  /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED)\b/i,
];

export function isRosterLookupUnavailable(itemOrReason) {
  if (itemOrReason && typeof itemOrReason === 'object' && itemOrReason.hasRoster) {
    return false;
  }

  const rawReason = typeof itemOrReason === 'string'
    ? itemOrReason
    : itemOrReason?.failReason;
  const reason = String(rawReason || '').trim();
  if (!reason) return false;

  return LOOKUP_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(reason));
}

export function formatRosterFailureReason(failReason) {
  const reason = String(failReason || '').trim();
  if (!reason) return '';

  if (/^HTTP 403$/i.test(reason)) return 'lookup blocked';
  if (/^HTTP 404$/i.test(reason)) return 'not found';
  if (/^HTTP 429$/i.test(reason) || /^Rate limited/i.test(reason)) return 'rate limited';
  if (/^HTTP (500|502|503|504)$/i.test(reason)) return 'lookup unavailable';
  if (/^timeout$/i.test(reason) || /timed out/i.test(reason)) return 'lookup timeout';
  if (/Stronghold lookup service is offline/i.test(reason)) return 'worker offline';
  if (/Scraping service overloaded/i.test(reason)) return 'worker busy';
  if (/Worker fetch failed/i.test(reason)) return 'worker fetch failed';

  return reason;
}

export function getRosterLookupDescription(item) {
  if (item?.hasRoster) return 'Has roster';
  if (item?.rosterLookupSkipped) return 'Roster lookup skipped';
  if (isRosterLookupUnavailable(item)) return 'Roster lookup unavailable';
  return 'No roster found';
}

export function getRosterLookupEmoji(item) {
  if (item?.hasRoster) return '❓';
  if (item?.rosterLookupSkipped) return '❓';
  if (isRosterLookupUnavailable(item)) return '⚠️';
  return '⚪';
}
