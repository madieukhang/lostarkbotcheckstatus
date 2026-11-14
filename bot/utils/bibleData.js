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
 * Decoder rationale:
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
 *     introduce them and crash a worker without this guard.
 */

import { readBodyWithin } from './responseBody.js';

// Bodies from lostark.bible, ScraperAPI or the worker are read up to this
// size; a real roster or character page is well under it.
export const BIBLE_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read a Bible response body as text, refusing one over BIBLE_BODY_MAX_BYTES.
 * @param {Response} response - fetch response with an unread body
 * @returns {Promise<string>} the body
 * @throws {RangeError} with code BODY_TOO_LARGE when the body is over the cap
 */
export async function readBibleText(response) {
  return new TextDecoder().decode(await readBodyWithin(response, BIBLE_BODY_MAX_BYTES));
}

/**
 * Decode a value at index `idx` from a SvelteKit deduped data array. Each
 * object or array node is decoded once and shared by every reference to it,
 * so a payload whose nodes point at the same children costs linear time; a
 * node reached again while it is still being decoded is a cycle and reads
 * as null.
 *
 * @param {Array} data - The flat `nodes[i].data` array.
 * @param {number|null|undefined} idx - Index into `data`, or sentinel.
 * @param {Map<number, any>} [decoded] - Nodes already decoded in this walk.
 * @param {Set<number>} [inProgress] - Nodes on the current path.
 * @returns {any} Reconstructed value (primitives, plain objects, arrays).
 */
function decodeBibleData(data, idx, decoded = new Map(), inProgress = new Set()) {
  const invalidReference = idx === undefined
    || idx === null
    || idx === -1
    || !Array.isArray(data)
    || inProgress.has(idx);
  if (invalidReference) return null;
  const value = data[idx];
  if (value === null || typeof value !== 'object') return value;
  if (decoded.has(idx)) return decoded.get(idx);
  inProgress.add(idx);
  const decodeChild = (subIdx) => decodeBibleData(data, subIdx, decoded, inProgress);
  const out = Array.isArray(value)
    ? value.map(decodeChild)
    : Object.fromEntries(Object.entries(value).map(([key, subIdx]) => [key, decodeChild(subIdx)]));
  inProgress.delete(idx);
  decoded.set(idx, out);
  return out;
}

/**
 * Walk a parsed `__data.json` response and decode the first node whose
 * decoded payload contains `predicateKey` at the top level. Bible's
 * routes split nodes per layout layer (root / page / sub-page); the
 * caller selects a layer by passing the key that appears
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
