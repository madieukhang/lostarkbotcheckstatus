import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findBibleNode, readBibleText, BIBLE_BODY_MAX_BYTES } from '../bot/utils/bibleData.js';
import { parseCharacterMetaFromHtml, parseRosterCharactersFromHtml } from '../bot/services/roster/parsers.js';

// lostark.bible and ScraperAPI answers are outside input: a few hundred
// bytes must not cost the bot seconds or its heap.

test('a devalue payload whose nodes share children decodes in linear time', () => {
  const depth = 18;
  const data = [{ header: 1 }];
  for (let i = 1; i <= depth; i += 1) data.push(i === depth ? 'leaf' : { a: i + 1, b: i + 1, c: i + 1 });
  const started = performance.now();
  const decoded = findBibleNode({ nodes: [{ data }] }, 'header');
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 200, `decoded in ${elapsed.toFixed(0)} ms`);
  let node = decoded.header;
  for (let i = 1; i < depth - 1; i += 1) node = node.b;
  assert.equal(node.c, 'leaf');
});

test('a page of unclosed stronghold objects parses in linear time', () => {
  const html = `rosterLevel:250,${'stronghold:{'.repeat(20_000)}`;
  const started = performance.now();
  parseCharacterMetaFromHtml(html);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `parsed in ${elapsed.toFixed(0)} ms`);
});

test('a real stronghold still parses', () => {
  const meta = parseCharacterMetaFromHtml('rosterLevel:300,stronghold:{level:70,name:"AinsHome"},guild:{name:"G",grade:"Member"}');
  assert.equal(meta.strongholdName, 'AinsHome');
});

test('roster cards whose name is not a character name are dropped', async () => {
  const card = (name) => `<a href="/character/NA/x"><div class="text-lg font-semibold">${name}<span>1740</span><span>3000</span></div></a>`;
  const html = [card('Alice'), card('[Re-verify](https://evil.example/login)'), card('x'.repeat(5000))].join('');
  const { document } = new JSDOM(html).window;
  const characters = await parseRosterCharactersFromHtml(html, document);
  assert.deepEqual(characters.map(({ name }) => name), ['Alice']);
});

test('a Bible body over the cap is refused instead of read whole', async () => {
  const huge = new Response(new Uint8Array(BIBLE_BODY_MAX_BYTES + 1));
  await assert.rejects(readBibleText(huge), (err) => err.code === 'BODY_TOO_LARGE');
  assert.equal(await readBibleText(new Response('ok')), 'ok');
});
