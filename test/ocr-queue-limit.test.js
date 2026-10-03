import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { default: config } = await import('../bot/config.js');
const { GEMINI_MODEL_PROFILES } = await import('../bot/config/geminiModels.js');
const {
  extractNamesFromImage,
  clearOcrCache,
  clearGeminiModelCooldowns,
  resetOcrSlotQueue,
  OcrQueueFullError,
  OCR_QUEUE_FULL_CODE,
} = await import('../bot/services/list-check/ocr.js');
const { createCheckHandlers } = await import('../bot/handlers/list/check/index.js');

const image = (name) => ({ url: `https://cdn.example.test/${name}.png`, contentType: 'image/png' });
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const namesResponse = (text = '["Alice"]') => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });

function setup(t, { cap = 2 } = {}) {
  clearOcrCache();
  clearGeminiModelCooldowns();
  resetOcrSlotQueue();
  const original = {
    geminiApiKey: config.geminiApiKey,
    geminiModels: config.geminiModels,
    geminiAnalysisModels: config.geminiAnalysisModels,
    listcheckOcrMaxQueue: config.listcheckOcrMaxQueue,
  };
  Object.assign(config, {
    geminiApiKey: 'test-key',
    geminiModels: [...GEMINI_MODEL_PROFILES.daily],
    listcheckOcrMaxQueue: cap,
  });
  t.after(() => {
    Object.assign(config, original);
    clearOcrCache();
    clearGeminiModelCooldowns();
    resetOcrSlotQueue();
  });
}

test('requests past the OCR queue cap are rejected immediately, without queuing or leaking the slot', async (t) => {
  setup(t);
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let gateOpen = false;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'cdn.example.test') {
      downloads += 1;
      // The active job parks on its download and keeps holding the slot.
      await gate;
      return imageResponse();
    }
    return namesResponse();
  });

  const active = extractNamesFromImage(image('active'));
  // Yield so the first job is granted the slot before the queue forms.
  await new Promise((resolve) => setImmediate(resolve));
  const queued = [
    extractNamesFromImage(image('q1')),
    extractNamesFromImage(image('q2')),
  ];
  const overflow = extractNamesFromImage(image('overflow')).catch((error) => error);

  const error = await overflow;
  assert.ok(error instanceof OcrQueueFullError);
  assert.equal(error.code, OCR_QUEUE_FULL_CODE);
  assert.equal(error.name, 'OcrQueueFullError');
  assert.equal(error.limit, 2);
  assert.equal(error.queueDepth, 2);
  assert.equal(gateOpen, false, 'the rejection must not wait for the busy slot');
  assert.equal(downloads, 1, 'the rejected request must not download anything');

  gateOpen = true;
  releaseGate();
  assert.deepEqual(
    await Promise.all([active, ...queued]),
    [['Alice'], ['Alice'], ['Alice']],
  );
  // Queue drained and slot released: a later request is served normally.
  assert.deepEqual(await extractNamesFromImage(image('after')), ['Alice']);
  assert.equal(downloads, 4);
});

test('requests within the cap are still serialized through the single OCR slot', async (t) => {
  setup(t);
  let concurrent = 0;
  let peak = 0;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'cdn.example.test') {
      downloads += 1;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return imageResponse();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return namesResponse();
  });

  const first = extractNamesFromImage(image('seq1'));
  await new Promise((resolve) => setImmediate(resolve));
  const second = extractNamesFromImage(image('seq2')); // queue length 1 < cap 2

  assert.deepEqual(await Promise.all([first, second]), [['Alice'], ['Alice']]);
  assert.equal(peak, 1, 'the cap must not weaken the single-slot serialization');
  assert.equal(downloads, 2);
});

test('/la-check mode:analysis is gated when no analysis model is enabled', async (t) => {
  setup(t);
  config.geminiAnalysisModels = [];
  const replays = [];
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    extractNamesFromImageFn: async () => {
      throw new Error('the OCR boundary must not be reached');
    },
  });
  await handleListCheckCommand({
    user: {},
    options: {
      getAttachment: () => image('gate'),
      getString: (name) => (name === 'mode' ? 'analysis' : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => { replays.push(payload); },
  });
  assert.equal(replays.length, 1, 'the gate must answer instead of the OCR flow');
  const alert = replays[0].embeds[0].toJSON();
  assert.ok(alert.title.endsWith('Analysis is unavailable'), `unexpected title: ${alert.title}`);
  assert.equal(alert.description, 'The bot currently has no enabled Analysis models. Your saved mode was not changed.');
});

test('/la-check answers an OCR queue-full rejection with the busy notice, not the generic OCR failure', async (t) => {
  setup(t);
  const replays = [];
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    getUserOcrModeFn: async () => 'daily',
    extractNamesFromImageFn: async () => {
      throw new OcrQueueFullError({ queueDepth: 2, limit: 2 });
    },
  });
  await handleListCheckCommand({
    user: {},
    options: {
      getAttachment: () => image('busy'),
      getString: (name) => (name === 'mode' ? null : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => { replays.push(payload); },
  });
  assert.equal(replays.length, 1);
  const alert = replays[0].embeds[0].toJSON();
  assert.ok(alert.title.endsWith('The image reader is busy'), `unexpected title: ${alert.title}`);
  assert.ok(alert.description.includes('2'), 'the notice should show the queue limit');
});
