import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { default: config } = await import('../bot/config.js');
const { GEMINI_MODEL_PROFILES } = await import('../bot/config/geminiModels.js');
const { extractNamesFromImage, clearOcrCache, clearGeminiModelCooldowns } = await import('../bot/services/list-check/ocr.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { buildCommands } = await import('../bot/commands/index.js');
const { createCheckHandlers } = await import('../bot/handlers/list/check/index.js');
const { t: translate } = await import('../bot/services/i18n/index.js');

const image = { url: 'https://cdn.example.test/profile.png', contentType: 'image/png' };
function response(text) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
}

function mockOcr(t, handleModel) {
  clearOcrCache();
  clearGeminiModelCooldowns();
  clearNameSuggestionCache();
  const original = {
    geminiApiKey: config.geminiApiKey,
    geminiModels: config.geminiModels,
    geminiAnalysisModels: config.geminiAnalysisModels,
  };
  Object.assign(config, {
    geminiApiKey: 'test-key',
    geminiModels: [...GEMINI_MODEL_PROFILES.daily],
    geminiAnalysisModels: [...GEMINI_MODEL_PROFILES.analysis],
  });
  t.after(() => {
    Object.assign(config, original);
    clearOcrCache();
    clearGeminiModelCooldowns();
    clearNameSuggestionCache();
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'cdn.example.test') return new Response(new Uint8Array([1, 2, 3]));
    if (parsed.hostname === 'generativelanguage.googleapis.com') {
      const model = decodeURIComponent(parsed.pathname.split('/models/')[1].split(':')[0]);
      calls.push(model);
      return handleModel(model, JSON.parse(options.body));
    }
    // A compact Bible result with two spellings triggers the existing targeted
    // image refinement without any real network or database access.
    if (parsed.pathname.includes('/_app/remote/ngsbie/search')) {
      const data = [[1, 5], [2, 3, 4], 'Crüelfighter', 'infighter_male', 1768, [6, 7, 8], 'Cruelfighter', 'blade', 1640];
      return Response.json({ type: 'result', result: JSON.stringify(data) });
    }
    assert.fail(`Unexpected request to ${parsed.hostname}`);
  });
  return calls;
}

test('default daily OCR handles 429 and 503 without spending analysis quota', async (t) => {
  const calls = mockOcr(t, model => new Response('temporarily unavailable', {
    status: model === GEMINI_MODEL_PROFILES.daily[0] ? 429 : 503,
  }));
  const error = await extractNamesFromImage(image).catch(error => error);
  assert.equal(error.code, 'GEMINI_MODELS_COOLING_DOWN');
  assert.ok(error.retryAfterMs > 0);
  assert.deepEqual(calls, GEMINI_MODEL_PROFILES.daily);
  await assert.rejects(extractNamesFromImage(image), { code: 'GEMINI_MODELS_COOLING_DOWN' });
  assert.equal(calls.length, 2, 'a cooling profile must not probe Flash or repeat Lite calls');
});

test('daily fallback stays on the second Lite after a recoverable failure', async (t) => {
  const calls = mockOcr(t, model => model === GEMINI_MODEL_PROFILES.daily[0]
    ? new Response('busy', { status: 503 })
    : response('["Alice"]'));
  assert.deepEqual(await extractNamesFromImage(image), ['Alice']);
  assert.deepEqual(calls, GEMINI_MODEL_PROFILES.daily);
});

test('analysis has its own cache and starts at 3.8 even when daily models are cooling', async (t) => {
  let failDaily = false;
  const calls = mockOcr(t, model => {
    if (GEMINI_MODEL_PROFILES.daily.includes(model)) {
      return failDaily ? new Response('quota', { status: 429 }) : response('["Alice"]');
    }
    return response('["Bob"]');
  });
  assert.deepEqual(await extractNamesFromImage(image), ['Alice']);
  assert.deepEqual(await extractNamesFromImage(image, { mode: 'analysis' }), ['Bob']);
  assert.deepEqual(await extractNamesFromImage(image), ['Alice']);
  assert.equal(calls.length, 2, 'both profiles retain their own cached answer');
  clearOcrCache();
  failDaily = true;
  await assert.rejects(extractNamesFromImage(image), { code: 'GEMINI_MODELS_COOLING_DOWN' });
  assert.deepEqual(await extractNamesFromImage(image, { mode: 'analysis' }), ['Bob']);
  assert.equal(calls.at(-1), 'gemini-3.8-flash');
});

test('analysis failover uses every Flash model and never drops into Lite', async (t) => {
  const calls = mockOcr(t, () => new Response('busy', { status: 503 }));
  await assert.rejects(extractNamesFromImage(image, { mode: 'analysis' }), { code: 'GEMINI_MODELS_COOLING_DOWN' });
  assert.deepEqual(calls, GEMINI_MODEL_PROFILES.analysis);
});

for (const mode of ['daily', 'analysis']) {
  test(`${mode} refinement stays inside the selected model profile`, async (t) => {
    let count = 0;
    const calls = mockOcr(t, () => response(++count === 1
      ? '["Cruelfighter"]' : '{"Cruelfighter":"Crüelfighter"}'));
    assert.deepEqual(await extractNamesFromImage(image, {
      mode, refineAmbiguousDiacritics: true,
    }), ['Crüelfighter']);
    assert.deepEqual(calls, [GEMINI_MODEL_PROFILES[mode][0], GEMINI_MODEL_PROFILES[mode][0]]);
  });
}

test('disabled or invalid analysis requests fail before any network access', async (t) => {
  const calls = mockOcr(t, () => assert.fail('No model should run'));
  config.geminiAnalysisModels = [];
  await assert.rejects(extractNamesFromImage(image, { mode: 'analysis' }), /No Gemini models are enabled/);
  await assert.rejects(extractNamesFromImage(image, { mode: 'unknown' }), /Unknown OCR mode/);
  assert.deepEqual(calls, []);
});

test('/la-check exposes optional Daily and Analysis choices with localized copy', () => {
  const command = buildCommands().find(command => command.name === 'la-check');
  const option = command.options.find(option => option.name === 'mode');
  assert.equal(option.required, false);
  assert.deepEqual(option.choices.map(choice => choice.value), ['daily', 'analysis']);
  for (const lang of ['en', 'vi', 'jp']) {
    for (const key of ['options.mode', 'modes.daily', 'modes.analysis']) {
      assert.notEqual(translate(`commands.check.${key}`, lang), `commands.check.${key}`);
    }
  }
});

test('/la-check forwards explicit analysis and defaults an omitted mode to daily', async () => {
  const calls = [];
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    extractNamesFromImageFn: async (actualImage, options) => {
      assert.equal(actualImage, image);
      calls.push(options.mode);
      return [];
    },
  });
  for (const mode of [null, 'analysis']) {
    await handleListCheckCommand({
      user: {},
      options: {
        getAttachment: () => image,
        getString: name => { assert.equal(name, 'mode'); return mode; },
      },
      deferReply: async () => {},
      editReply: async () => {},
    });
  }
  assert.deepEqual(calls, ['daily', 'analysis']);
});

test('/la-check uses the saved mode while an explicit override leaves it untouched', async () => {
  const calls = [];
  let preferenceReads = 0;
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    getUserOcrModeFn: async () => { preferenceReads += 1; return 'analysis'; },
    extractNamesFromImageFn: async (_image, options) => { calls.push(options.mode); return []; },
  });
  for (const mode of [null, 'daily']) {
    await handleListCheckCommand({
      user: {},
      options: { getAttachment: () => image, getString: () => mode },
      deferReply: async () => {}, editReply: async () => {},
    });
  }
  assert.deepEqual(calls, ['analysis', 'daily']);
  assert.equal(preferenceReads, 1, 'an explicit single-image override needs no preference read/write');
});
