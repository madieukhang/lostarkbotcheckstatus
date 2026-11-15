import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';

// jsdom takes about a second to load, and most modules that can parse a page
// are imported by tests and handlers that never parse one. Only
// services/roster/dom.js names jsdom, and it loads it on first use, so
// importing any other module leaves jsdom unloaded.
const BOT_DIR = new URL('../bot/', import.meta.url);
const NAMES_JSDOM = /['"]jsdom['"]/;

function botFilesNamingJsdom() {
  return readdirSync(BOT_DIR, { recursive: true })
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.split(sep).join('/'))
    .filter((file) => NAMES_JSDOM.test(readFileSync(new URL(file, BOT_DIR), 'utf8')));
}

test('only the DOM helper names jsdom', () => {
  assert.deepEqual(botFilesNamingJsdom(), ['services/roster/dom.js']);
});

test('the DOM helper loads jsdom on first use, not when it is imported', () => {
  const source = readFileSync(new URL('services/roster/dom.js', BOT_DIR), 'utf8');
  assert.equal(source.includes("from 'jsdom'"), false);
  assert.equal(source.includes("import('jsdom')"), true);
});
