const DISPLAY_CLASSIFICATIONS = Object.freeze([
  { status: 'black', entryKey: 'blackEntry', priority: 0 },
  { status: 'watch', entryKey: 'watchEntry', priority: 1 },
  { status: 'white', entryKey: 'whiteEntry', priority: 2 },
  { status: 'trusted', entryKey: 'trustedEntry', priority: 2 },
]);

function classifyResult(item) {
  for (const classification of DISPLAY_CLASSIFICATIONS) {
    const entry = item?.[classification.entryKey];
    if (entry) return { ...classification, entry };
  }
  return { status: 'notListed', entryKey: null, entry: null, priority: 3 };
}

/**
 * Group display rows only when their blacklist/watchlist/whitelist records
 * point to the same underlying entries and their trusted state agrees. Mongo
 * `_id` is authoritative; object identity is a safe fallback for tests and
 * callers that provide unsaved entry objects.
 *
 * Raw results remain untouched so Quick Add, evidence details, and audit data
 * can continue operating per photographed character.
 */
export function groupListCheckResults(results = []) {
  const groups = [];
  const groupsBySignature = new Map();
  const objectRefs = new WeakMap();
  let nextObjectRef = 1;

  function entryRef(entry) {
    const persistedId = String(entry?._id || '').trim();
    if (persistedId) return `id:${persistedId}`;
    if (!entry || (typeof entry !== 'object' && typeof entry !== 'function')) return '';
    if (!objectRefs.has(entry)) {
      objectRefs.set(entry, nextObjectRef);
      nextObjectRef += 1;
    }
    return `object:${objectRefs.get(entry)}`;
  }

  for (const [order, item] of results.entries()) {
    const classification = classifyResult(item);
    if (classification.status === 'notListed') {
      groups.push({ ...classification, items: [item], order });
      continue;
    }

    const listSignature = DISPLAY_CLASSIFICATIONS
      .filter(({ status }) => status !== 'trusted')
      .map(({ status, entryKey }) => {
        const ref = entryRef(item?.[entryKey]);
        return ref ? `${status}:${ref}` : '';
      })
      .filter(Boolean);

    // For a blacklist/watchlist/whitelist group, the precise TrustedUser
    // document is secondary and is not rendered. Its boolean presence is
    // enough to keep the shield honest without splitting one roster merely
    // because separate trusted records confirmed different photographed alts.
    // Trusted-only rows still use the persisted entry identity as their key.
    if (classification.status === 'trusted') {
      listSignature.push(`trusted:${entryRef(item.trustedEntry)}`);
    } else {
      listSignature.push(`trusted:${Boolean(item.trustedEntry)}`);
    }
    const signature = listSignature.join('|');

    let group = groupsBySignature.get(signature);
    if (!group) {
      group = { ...classification, items: [], order };
      groupsBySignature.set(signature, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}
