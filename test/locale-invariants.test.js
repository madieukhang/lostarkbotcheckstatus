/**
 * test/locale-invariants.test.js
 * Machine-checkable guards for the LoaLogs locale packs, ported from the
 * RaidManage voice pass. Discipline across ~1000 keys x 3 locales leaks; these
 * assertions are what keeps it honest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TRANSLATIONS } from '../bot/locales/index.js';

const LANGS = ['en', 'vi', 'jp'];
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

// vi and jp have no plural/counter word, so these keys legitimately drop the
// word token English needs. Any OTHER divergence is a bug.
const PLACEHOLDER_EXCEPTIONS = new Set([
  'dialogue.stats.recentBlacklist',
  'dialogue.broadcast.headlines.enriched',
  'dialogue.check.ignored',
]);

function flatten(node, prefix, out) {
  if (node == null) return out;
  if (typeof node === 'string' || Array.isArray(node)) {
    out.set(prefix, node);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const MAPS = Object.fromEntries(
  LANGS.map((lang) => [lang, flatten(TRANSLATIONS[lang], '', new Map())])
);

/** Every string a leaf contributes, whether plain, multi-line block, or pool. */
function membersOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

function tokensOf(value) {
  return new Set(
    membersOf(value).flatMap((s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]))
  );
}

test('locale key sets are identical across en/vi/jp', () => {
  const base = [...MAPS.en.keys()].sort();
  for (const lang of ['vi', 'jp']) {
    const missing = base.filter((k) => !MAPS[lang].has(k));
    const extra = [...MAPS[lang].keys()].filter((k) => !MAPS.en.has(k));
    assert.deepEqual(missing, [], `${lang} is missing keys`);
    assert.deepEqual(extra, [], `${lang} has keys en does not`);
  }
});

test('each key carries the same placeholder SET in every locale', () => {
  // Set-based, not count-based: a locale may legitimately repeat a token.
  const offenders = [];
  for (const key of MAPS.en.keys()) {
    if (PLACEHOLDER_EXCEPTIONS.has(key)) continue;
    const base = tokensOf(MAPS.en.get(key));
    for (const lang of ['vi', 'jp']) {
      if (!MAPS[lang].has(key)) continue;
      const other = tokensOf(MAPS[lang].get(key));
      const diff = [...base]
        .filter((tok) => !other.has(tok))
        .concat([...other].filter((tok) => !base.has(tok)));
      if (diff.length > 0) offenders.push(`${key} [en vs ${lang}]: ${diff.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('variant pool members share their siblings placeholder set', () => {
  // A pool member that drops {n} shows a literal {n} one time in N - that reads
  // as a flake rather than a bug, so it must be caught mechanically.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (!key.endsWith('.variants') || !Array.isArray(value)) continue;
      const sets = value.map(
        (member) => new Set([...String(member).matchAll(PLACEHOLDER)].map((m) => m[1]))
      );
      const [first, ...rest] = sets;
      rest.forEach((set, i) => {
        const diff = [...first]
          .filter((tok) => !set.has(tok))
          .concat([...set].filter((tok) => !first.has(tok)));
        if (diff.length > 0) {
          offenders.push(`${lang}:${key}[${i + 1}] differs by ${diff.join(', ')}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test('variant pools are non-empty arrays of strings', () => {
  // Guards the exact mistake a scripted string -> pool conversion makes when it
  // anchors on a bare string that is already a member of another pool: the
  // nested object still parses and renders as [object Object] in Discord.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (!key.endsWith('.variants')) continue;
      if (!Array.isArray(value) || value.length === 0) {
        offenders.push(`${lang}:${key} is not a non-empty array`);
        continue;
      }
      if (value.some((member) => typeof member !== 'string')) {
        offenders.push(`${lang}:${key} holds a non-string member`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('locale copy contains no em-dash', () => {
  // feedback_no_emdash: user-facing text uses a plain hyphen.
  const offenders = [];
  for (const lang of LANGS) {
    for (const [key, value] of MAPS[lang]) {
      if (membersOf(value).some((s) => s.includes('—'))) offenders.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every /la-help label opens with an icon', () => {
  // The overview groups have carried icons since they were written; the
  // two detail sections did not, which made drilling into a section feel
  // like leaving the card family. Labels are what the reader scans, so
  // this guards the whole namespace rather than the two sections that
  // happened to be bare.
  const offenders = [];
  const leadingIcon = /^\p{Extended_Pictographic}/u;

  const walk = (node, path, lang) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, lang));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if ((key === 'name' || key === 'title') && !leadingIcon.test(value)) {
          offenders.push(`${lang}:${path}.${key}`);
        }
        continue;
      }
      walk(value, `${path}.${key}`, lang);
    }
  };

  for (const lang of LANGS) walk(TRANSLATIONS[lang]?.help, 'help', lang);
  assert.deepEqual(offenders, []);
});
