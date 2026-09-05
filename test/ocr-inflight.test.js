import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import { GEMINI_MODEL_PROFILES } from '../bot/config/geminiModels.js';
import { extractNamesFromImage, clearOcrCache, clearGeminiModelCooldowns } from '../bot/services/list-check/ocr.js';

const image = { url: 'https://cdn.discordapp.com/concurrent.png', contentType: 'image/png' };
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const namesResponse = (text = '["Alice"]') => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });

function setup(t) {
  clearOcrCache();
  clearGeminiModelCooldowns();
  const key = config.geminiApiKey;
  config.geminiApiKey = 'offline-test-key';
  t.after(() => { config.geminiApiKey = key; clearOcrCache(); clearGeminiModelCooldowns(); });
}

test('concurrent OCR of the same image shares download and Gemini work but returns independent arrays', async t => {
  setup(t);
  let downloads = 0;
  let modelCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url) === image.url) { downloads += 1; await gate; return imageResponse(); }
    modelCalls += 1;
    return namesResponse();
  });
  const requests = Array.from({ length: 5 }, () => extractNamesFromImage(image));
  release();
  const results = await Promise.all(requests);
  assert.equal(downloads, 1);
  assert.equal(modelCalls, 1);
  results[0].push('Changed');
  assert.deepEqual(results[1], ['Alice']);
});

for (const mode of ['daily', 'analysis']) {
  test(`${mode} cooldown skips downloads, keeps cached answers and recovers after expiry`, async t => {
    setup(t);
    const original = { geminiModels: config.geminiModels, geminiAnalysisModels: config.geminiAnalysisModels };
    Object.assign(config, { geminiModels: GEMINI_MODEL_PROFILES.daily, geminiAnalysisModels: GEMINI_MODEL_PROFILES.analysis });
    t.after(() => Object.assign(config, original));
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let busy = false;
    const downloads = [];
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) {
        downloads.push(url);
        return imageResponse();
      }
      const model = new URL(url).pathname.split('/models/')[1].split(':')[0];
      calls.push(model);
      return busy && GEMINI_MODEL_PROFILES[mode].includes(model)
        ? new Response('temporarily unavailable', { status: calls.length % 2 ? 429 : 503 })
        : namesResponse();
    });
    assert.deepEqual(await extractNamesFromImage(image, { mode }), ['Alice']);
    busy = true;
    const uncached = { ...image, url: 'https://cdn.discordapp.com/uncached.png' };
    await assert.rejects(extractNamesFromImage(uncached, { mode }), { code: 'GEMINI_MODELS_COOLING_DOWN' });
    const attempts = calls.length;
    const error = await extractNamesFromImage(uncached, { mode }).catch(error => error);
    assert.equal(error.code, 'GEMINI_MODELS_COOLING_DOWN');
    assert.ok(error.retryAfterMs > 0);
    assert.equal(downloads.length, 2, 'a known unavailable profile must fail before downloading again');
    assert.equal(calls.length, attempts);
    assert.deepEqual(await extractNamesFromImage(image, { mode }), ['Alice']);
    assert.equal(downloads.length, 2, 'cached results remain usable during cooldown');
    const otherMode = mode === 'daily' ? 'analysis' : 'daily';
    assert.deepEqual(await extractNamesFromImage(uncached, { mode: otherMode }), ['Alice']);
    assert.equal(calls.at(-1), GEMINI_MODEL_PROFILES[otherMode][0]);
    now += error.retryAfterMs + 1;
    busy = false;
    assert.deepEqual(await extractNamesFromImage(uncached, { mode }), ['Alice']);
    assert.equal(downloads.length, 4);
  });
}

test('in-flight OCR keeps Daily, Analysis and refinement requests separate', async t => {
  setup(t);
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url) === image.url) { downloads += 1; return imageResponse(); }
    return namesResponse('[]');
  });
  await Promise.all([
    extractNamesFromImage(image, { mode: 'daily' }),
    extractNamesFromImage(image, { mode: 'analysis' }),
    extractNamesFromImage(image, { mode: 'daily', refineAmbiguousDiacritics: true }),
  ]);
  assert.equal(downloads, 3);
});

test('a failed shared OCR request is released so a later request can retry', async t => {
  setup(t);
  let downloads = 0;
  let fail = true;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url) === image.url) {
      downloads += 1;
      return fail ? new Response('', { status: 503 }) : imageResponse();
    }
    return namesResponse();
  });
  const failed = await Promise.allSettled([extractNamesFromImage(image), extractNamesFromImage(image)]);
  assert.ok(failed.every(result => result.status === 'rejected'));
  assert.equal(downloads, 1);
  fail = false;
  assert.deepEqual(await extractNamesFromImage(image), ['Alice']);
  assert.equal(downloads, 2);
});
