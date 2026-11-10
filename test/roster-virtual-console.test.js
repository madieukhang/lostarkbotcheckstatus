import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRosterVirtualConsole } from '../bot/services/roster/dom.js';

// Roster and status pages ship stylesheets jsdom cannot parse; that is
// expected and must not fill the log on every lookup.
const BROKEN_CSS_PAGE = '<html><head><style>a{color:red;}} @media {{{ b{</style></head><body><p class="x">ok</p></body></html>';

test('a page with a broken stylesheet parses and logs nothing', () => {
  const warnings = [];
  const virtualConsole = createRosterVirtualConsole({ warn: (...args) => warnings.push(args) });

  const dom = new JSDOM(BROKEN_CSS_PAGE, { virtualConsole });

  assert.equal(dom.window.document.querySelector('.x').textContent, 'ok');
  assert.deepEqual(warnings, []);
});

test('jsdom errors other than CSS parsing still reach the log', () => {
  const warnings = [];
  const virtualConsole = createRosterVirtualConsole({ warn: (...args) => warnings.push(args) });

  virtualConsole.emit('jsdomError', Object.assign(new Error('Not implemented: navigation'), { type: 'not-implemented' }));

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1]), /Not implemented/);
});
