import { fetchNameSuggestions } from '../roster/search.js';

/**
 * Canonicalise a name for diacritic-tolerant comparison. Strips
 * combining marks (NFD decomposition + drop ̀-ͯ) and
 * lowercases. Used when bible search returns a canonical candidate
 * for a name where Gemini OCR added, dropped, or swapped a mark.
 */
export function stripDiacritics(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function diacriticGroups(value) {
  const groups = [];
  for (const ch of String(value || '').normalize('NFD').toLowerCase()) {
    if (/[\u0300-\u036f]/u.test(ch)) {
      if (groups.length > 0) groups[groups.length - 1] += ch;
    } else {
      groups.push('');
    }
  }
  return groups;
}

export function hasAnyDiacritic(value) {
  return diacriticGroups(value).some(Boolean);
}

function diacriticDistance(a, b) {
  if (stripDiacritics(a) !== stripDiacritics(b)) return Infinity;
  const left = diacriticGroups(a);
  const right = diacriticGroups(b);
  if (left.length !== right.length) return Infinity;
  let score = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    // A wrong accent type on the same glyph is safer than inventing or
    // deleting a mark. This lets OCR "Crúelfighter" snap to
    // "Crüelfighter" over the real unmarked "Cruelfighter", while
    // still refusing tied cases such as "Aürélia".
    score += left[i] && right[i] ? 1 : 2;
  }
  return score;
}

export function medianNumber(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Aggressive ASCII fallback for bible search retries. Strips combining
// marks AND any remaining non-ASCII codepoint (catches Cyrillic
// look-alikes and other Unicode confusables that survive Gemini's OCR
// + normalizeCharacterName). Bible's search index is diacritic-
// tolerant on the server side, so a pure-ASCII query like
// "banhcanhcua" still returns the canonical "B\u00e1nhcanhc\u00fca". Empty
// string is returned when nothing ASCII survives, in which case the
// caller skips the retry.
export function asciiFoldName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase();
}

function visualNameKey(value) {
  return stripDiacritics(value)
    .replace(/[l1]/g, 'i')
    .replace(/0/g, 'o');
}

export function buildDiaeresisDigraphVariants(value) {
  const source = String(value || '');
  const variants = new Set();
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '\u00EF' && ch !== '\u00CF') continue;
    const replacements = ch === '\u00CF' ? ['Iy', 'Yi'] : ['iy', 'yi'];
    for (const replacement of replacements) {
      variants.add(`${source.slice(0, i)}${replacement}${source.slice(i + 1)}`);
    }
  }
  return [...variants].filter((variant) => variant !== source);
}

function buildSingleVisualSubstitutionVariants(value) {
  const source = String(value || '');
  const variants = new Set();
  for (let i = 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === 'q') variants.add(`${source.slice(0, i)}y${source.slice(i + 1)}`);
    if (ch === 'Q') variants.add(`${source.slice(0, i)}Y${source.slice(i + 1)}`);
  }
  return [...variants].filter((variant) => variant !== source);
}

// Is `a` a subsequence of `b`? (every char of a appears in b in order).
// Used to distinguish a pure insertion/deletion (indel · subsequence
// holds one way) from a same-length substitution (subsequence fails
// both ways), so prefix-indel recovery only fires on the safe class.
function isSubsequence(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j += 1) {
    if (a[i] === b[j]) i += 1;
  }
  return i === a.length;
}

function isSingleAdjacentTransposition(a, b) {
  if (a.length !== b.length || a === b) return false;
  const diffs = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length > 2) return false;
  }
  if (diffs.length !== 2) return false;
  const [first, second] = diffs;
  return second === first + 1
    && a[first] === b[second]
    && a[second] === b[first];
}

function buildRecoveryPrefixes(folded, minLength = 4) {
  const maxLength = Math.min(folded.length, 10);
  const prefixes = [];
  for (let len = maxLength; len >= minLength; len -= 1) {
    prefixes.push(folded.slice(0, len));
  }
  return [...new Set(prefixes)];
}

async function recoverViaPrefixCandidates(name, predicate, options = {}) {
  const folded = asciiFoldName(name);
  if (folded.length < 5) return null;

  const matches = new Map();
  for (const prefix of buildRecoveryPrefixes(folded)) {
    const suggestions = await fetchNameSuggestions(prefix, options);
    if (suggestions === null) return null;
    if (!Array.isArray(suggestions) || suggestions.length === 0) continue;
    const before = matches.size;
    for (const s of suggestions) {
      const cand = asciiFoldName(String(s.name));
      if (!predicate(folded, cand)) continue;
      matches.set(String(s.name).toLowerCase(), s);
    }
    if (matches.size > before && suggestions.length < 10) break;
  }

  return matches.size === 1 ? [...matches.values()][0] : null;
}

/**
 * Levenshtein edit distance · O(m·n) DP with rolling rows. Returns the
 * minimum number of single-character insertions / deletions / swaps to
 * turn `a` into `b`. Used to recover from Gemini OCR mistakes like
 * doubled letters ("Trùmffighter" vs "Trùmfighter" → distance 1) when
 * an exact / diacritic-tolerant match against bible's search results
 * doesn't land.
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const curr = new Array(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

export function chooseCanonicalSuggestion(name, suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

  // First pass: case-insensitive exact match for cases where Gemini preserved
  // every character but changed casing.
  const target = String(name).toLowerCase();
  let chosen = suggestions.find((s) => String(s.name).toLowerCase() === target);
  if (chosen) return { chosen, reason: 'exact' };

  // Second pass: diacritic-tolerant match. Gemini sometimes adds,
  // drops, or swaps marks; bible's search can still return the real
  // canonical name as a nearby candidate. Accept this only when the
  // ASCII-folded base maps to ONE suggestion. If Bible returns multiple
  // real characters that differ only by marks (e.g. Aüreliá, Aürélía,
  // Aürélià), the OCR string must be exact; otherwise guessing from
  // search order silently assigns the wrong class/ilvl to a real player.
  const targetCanonical = stripDiacritics(name);
  const diacriticMatches = suggestions.filter(
    (s) => stripDiacritics(String(s.name)) === targetCanonical
  );
  if (diacriticMatches.length === 1) {
    return { chosen: diacriticMatches[0], reason: 'diacritic' };
  }
  const ambiguousDiacriticMatch = diacriticMatches.length > 1;
  if (ambiguousDiacriticMatch && hasAnyDiacritic(name)) {
    const ranked = diacriticMatches
      .map((s) => ({ suggestion: s, distance: diacriticDistance(name, String(s.name)) }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked[0]?.distance < ranked[1]?.distance) {
      return { chosen: ranked[0].suggestion, reason: 'diacritic' };
    }
  }

  // Third pass: targeted visual look-alike match for short names where
  // a full edit-distance pass would be too loose.
  if (ambiguousDiacriticMatch) return null;

  const targetVisual = visualNameKey(name);
  if (targetVisual !== targetCanonical) {
    chosen = suggestions.find((s) => visualNameKey(String(s.name)) === targetVisual);
    if (chosen) return { chosen, reason: 'lookalike' };
  }

  // Fourth pass: edit-distance fuzzy match. Recovers small OCR errors
  // beyond accents: doubled/missing letters and other substitutions.
  if (targetCanonical.length < 6) return null;
  const maxDistance = Math.min(2, Math.floor(targetCanonical.length / 6));
  let bestMatch = null;
  let bestDistance = Infinity;
  for (const s of suggestions) {
    const dist = levenshteinDistance(
      targetCanonical,
      stripDiacritics(String(s.name))
    );
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = s;
    }
  }

  if (bestMatch && bestDistance <= maxDistance) {
    return { chosen: bestMatch, reason: 'fuzzy', distance: bestDistance, maxDistance };
  }
  return null;
}

/**
 * Recover a single canonical row for an OCR'd name that bible's search
 * can't match directly because exactly one letter was inserted or
 * dropped · usually a miscounted repeated letter ("Qiyllyn" for
 * "Qiylyn", "Lpiiv" for "Lpiiiv").
 *
 * bible search is prefix-based and caps suggestions, so a 4-char
 * prefix can be too broad for long names ("auro" does not surface
 * "Auroraformyluv"). Try longer prefixes first, then keep only
 * candidates that are exactly ONE indel away:
 *   - length differs by exactly 1 (rules out same-length substitution),
 *   - Levenshtein distance is exactly 1,
 *   - and a subsequence relationship holds (the shorter is a
 *     subsequence of the longer · confirms pure insertion/deletion,
 *     NOT a swap like "Viatchu" -> "Viatchy" that would otherwise
 *     mis-resolve to a different real player).
 *
 * Accept ONLY when exactly one candidate survives. Genuine ambiguity
 * (e.g. both "Lpiiiv" and "Lpiiiiv" exist) returns null so the row
 * renders bare instead of guessing the wrong character's class/ilvl.
 *
 * @returns {Promise<{name:string,cls:string,itemLevel:number}|null>}
 */
export async function recoverViaPrefixIndel(name, options = {}) {
  const folded = asciiFoldName(name);
  // Need >=5 chars so a short prefix still leaves room for the indel.
  if (folded.length < 5) return null;
  return recoverViaPrefixCandidates(name, (source, cand) => {
    if (!cand) return false;
    if (Math.abs(cand.length - folded.length) !== 1) return false;
    if (levenshteinDistance(source, cand) !== 1) return false;
    return isSubsequence(source, cand) || isSubsequence(cand, source);
  }, options);
}

/**
 * Recover a single canonical row when OCR swaps two adjacent letters
 * and bible's full-name search returns empty, e.g.
 * "Auroraforymluv" -> "Auroraformyluv". Same prefix-query strategy as
 * indel recovery, but the filter only accepts one adjacent transposition.
 * @returns {Promise<{name:string,cls:string,itemLevel:number}|null>}
 */
export async function recoverViaPrefixTransposition(name, options = {}) {
  const folded = asciiFoldName(name);
  if (folded.length < 6) return null;
  return recoverViaPrefixCandidates(
    name,
    (source, cand) => Boolean(cand) && isSingleAdjacentTransposition(source, cand),
    options
  );
}

export async function recoverViaVisualSubstitution(name, options = {}) {
  const source = stripDiacritics(name);
  if (source.length < 5) return null;

  const matches = new Map();
  for (const variant of buildSingleVisualSubstitutionVariants(name)) {
    const suggestions = await fetchNameSuggestions(variant, options);
    if (suggestions === null) return null;
    const match = chooseCanonicalSuggestion(variant, suggestions);
    if (!match || !['exact', 'diacritic'].includes(match.reason)) continue;

    const candidateBase = stripDiacritics(String(match.chosen.name));
    if (candidateBase !== stripDiacritics(variant)) continue;
    if (levenshteinDistance(source, candidateBase) !== 1) continue;
    matches.set(String(match.chosen.name).toLowerCase(), match.chosen);
  }

  return matches.size === 1 ? [...matches.values()][0] : null;
}
