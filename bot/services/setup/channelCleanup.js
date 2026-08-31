function cleanupFailureKey(err) {
  const code = err?.code ?? err?.rawError?.code ?? 'unknown';
  const message = String(
    err?.message || err?.rawError?.message || err?.name || 'Unknown error'
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return String(code) + ':' + message;
}

export function formatCleanupFailureReasons(failureReasons = {}) {
  return Object.entries(failureReasons)
    .map(([reason, count]) => reason + ' x' + count)
    .join(', ');
}

/**
 * Delete every non-pinned Discord message in a text channel, including
 * messages older than bulkDelete's 14-day limit. Explicit IDs protect a
 * freshly posted welcome during send-to-pin and DB-persistence windows.
 */
export async function cleanupChannelMessages(
  channel,
  { maxPages = 20, protectedMessageIds = [] } = {}
) {
  const protectedIds = new Set(
    [...protectedMessageIds].filter(Boolean).map(String)
  );
  let before;
  let deleted = 0;
  let failed = 0;
  let scanned = 0;
  let truncated = false;
  const failureReasons = {};

  for (let page = 0; page < maxPages; page += 1) {
    const fetchOptions = { limit: 100 };
    if (before) fetchOptions.before = before;
    const fetched = await channel.messages.fetch(fetchOptions);
    if (!fetched || fetched.size === 0) break;

    scanned += fetched.size;
    before = fetched.last?.()?.id;
    for (const message of fetched.values()) {
      if (message.pinned || protectedIds.has(String(message.id))) continue;
      try {
        await message.delete();
        deleted += 1;
      } catch (err) {
        failed += 1;
        const reason = cleanupFailureKey(err);
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
    }

    const pageComplete = fetched.size < 100;
    const cursorMissing = !before;
    truncated ||= !pageComplete && (cursorMissing || page === maxPages - 1);
    if (pageComplete || cursorMissing) break;
  }

  return { deleted, failed, scanned, truncated, failureReasons };
}
