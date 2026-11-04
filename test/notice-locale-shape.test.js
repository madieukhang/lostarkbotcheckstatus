import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { TRANSLATIONS } from '../bot/locales/index.js';

// A simple notice spreads a locale entry into the alert builder, which reads
// its `title`, `description` and `tip`. An entry without a title renders a
// card with no title, and Discord shows no markdown in a footer, so a
// backtick in a tip would print as a literal mark.
const LANGS = ['en', 'vi', 'jp'];

const get = (lang, key) => key.split('.').reduce((node, part) => node?.[part], TRANSLATIONS[lang]);

function walkObjects(node, path, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  visit(node, path);
  for (const [key, child] of Object.entries(node)) walkObjects(child, path ? `${path}.${key}` : key, visit);
}

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listJsFiles(path, out);
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

// Entries whose description lives in sibling keys picked at run time.
const DESCRIPTION_ELSEWHERE = Object.freeze({
  // bot/handlers/list/edit/command.js picks the global or server wording.
  'dialogue.listEdit.command.scopeBlocked': ['dialogue.listEdit.command.scopeBlockedGlobal', 'dialogue.listEdit.command.scopeBlockedServer'],
});

test('every locale entry with a tip is a whole notice with a plain tip', () => {
  const problems = [];
  for (const lang of LANGS) {
    walkObjects(TRANSLATIONS[lang], '', (node, path) => {
      // An entry carrying a footer is rich-card copy read leaf by leaf; the
      // builder refuses a tip and a footer together, so it is never a notice.
      if (typeof node.tip !== 'string' || 'footer' in node) return;
      if (!hasText(node.title)) problems.push(`${lang} ${path}: no title`);
      const descriptions = DESCRIPTION_ELSEWHERE[path]?.map((key) => get(lang, key)) ?? [node.description ?? node.empty];
      if (!descriptions.every(hasText)) problems.push(`${lang} ${path}: no description`);
      if (node.tip.includes('`')) problems.push(`${lang} ${path}: backtick in tip`);
    });
  }
  assert.deepEqual(problems, []);
});

// Keys spread (`...t('dialogue.x')`) or destructured (`const { title } =
// t('dialogue.x')`) into a notice in the bot source.
const SPREAD_KEY = /\.\.\.t\(\s*['"](dialogue\.[\w.]+)['"]/g;
const DESTRUCTURED_KEY = /\{[^}]*\btitle\b[^}]*\}\s*=\s*t\(\s*['"](dialogue\.[\w.]+)['"]/g;

test('every notice key the bot spreads into an alert has a title in every language', () => {
  const sites = new Map();
  for (const file of listJsFiles(join(process.cwd(), 'bot'))) {
    const path = relative(process.cwd(), file).replaceAll('\\', '/');
    if (path.startsWith('bot/locales/')) continue;
    const source = readFileSync(file, 'utf8');
    for (const pattern of [SPREAD_KEY, DESTRUCTURED_KEY]) {
      for (const match of source.matchAll(pattern)) {
        if (!sites.has(match[1])) sites.set(match[1], `${path}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
  }

  assert.ok(sites.size > 50, `expected the scan to find the notice keys, found ${sites.size}`);
  const problems = [];
  for (const [key, site] of sites) {
    for (const lang of LANGS) {
      if (!hasText(get(lang, key)?.title)) problems.push(`${lang} ${key} (${site}): no title`);
    }
  }
  assert.deepEqual(problems, []);
});
