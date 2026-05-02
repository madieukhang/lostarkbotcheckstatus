/**
 * Decoder for lostark.bible's SvelteKit `__data.json` payload format.
 *
 * SvelteKit serializes page data as a flat, deduplicated array. The
 * payload is shaped as:
 *
 *   { type: 'data', nodes: [{ type: 'data', data: [...] }, ...] }
 *
 * Each `nodes[i].data` is an array. Index 0 is the entry pointer; its
 * value is itself an index. Object values are maps of
 * `{ propName: indexIntoData }` and array values are lists of indexes.
 * Primitives (string / number / bool / null) are leaf values.
 *
 * To reconstruct the original page state, recursively walk indexes
 * starting at `data[0]`.
 *
 * Why we use this:
 *   - The raw HTML page embeds the same data under a `<script>` blob,
 *     and the legacy regex extractors against that blob are fragile.
 *     The `__data.json` endpoint is shorter, structured, and trivially
 *     deduplicates repeating values (rosterLevel, ilvl, etc).
 *   - For per-candidate alt-detect scans, switching off JSDOM parse
 *     drops a real CPU cost.
 *
 * Caveats:
 *   - This is bible's INTERNAL hydration format, not a stable public
 *     API. Callers MUST keep an HTML fallback path; if the format
 *     changes, callers should fall back transparently rather than fail
 *     hard.
 *   - The decoder must guard against cycles even though current
 *     payloads do not contain them, because a future bible build could
 *     introduce them and we do not want a crashed worker.
 */

/**
 * Decode a value at index `idx` from a SvelteKit deduped data array.
 *
 * @param {Array} data - The flat `nodes[i].data` array.
 * @param {number|null|undefined} idx - Index into `data`, or sentinel.
 * @param {Set<number>} [seen] - In-progress indexes for cycle guard.
 * @returns {any} Reconstructed value (primitives, plain objects, arrays).
 */
export function decodeBibleData(data, idx, seen = new Set()) {
  if (idx === undefined || idx === null || idx === -1) return null;
  if (!Array.isArray(data)) return null;
  if (seen.has(idx)) return null;
  const value = data[idx];
  if (value === null || typeof value !== 'object') return value;
  // Track only object/array nodes; primitives can repeat freely without
  // forming a cycle. Use a fresh `seen` per branch so siblings do not
  // shadow each other (they share parent-chain ancestors only).
  const branchSeen = new Set(seen);
  branchSeen.add(idx);
  if (Array.isArray(value)) {
    return value.map((sub) => decodeBibleData(data, sub, branchSeen));
  }
  const out = {};
  for (const [key, subIdx] of Object.entries(value)) {
    out[key] = decodeBibleData(data, subIdx, branchSeen);
  }
  return out;
}

/**
 * Walk a parsed `__data.json` response and decode the first node whose
 * decoded payload contains `predicateKey` at the top level. Bible's
 * routes split nodes per layout layer (root / page / sub-page); the
 * caller picks which layer they want by passing the key that appears
 * there.
 *
 * Returns `null` when no node matches so callers can fall back without
 * branching on `try/catch`.
 *
 * @param {object} parsed - JSON.parse'd response body.
 * @param {string} predicateKey - Top-level key to find (e.g. 'header').
 * @returns {object|null} Decoded payload object, or null.
 */
export function findBibleNode(parsed, predicateKey) {
  if (!parsed || !Array.isArray(parsed.nodes)) return null;
  for (const node of parsed.nodes) {
    if (!node || !Array.isArray(node.data)) continue;
    const decoded = decodeBibleData(node.data, 0);
    if (
      decoded &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      Object.prototype.hasOwnProperty.call(decoded, predicateKey)
    ) {
      return decoded;
    }
  }
  return null;
}
