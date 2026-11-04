import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Collection } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = '';

const { createCheckHandlers } = await import('../bot/handlers/list/check/index.js');
const { createOcrModeCommandHandler } = await import('../bot/handlers/list/check/mode.js');
const { createAutoCheckMessageHandler, resetAutoCheckDedupeForTest } = await import('../bot/handlers/list/auto-check.js');
const { OCR_QUEUE_FULL_CODE } = await import('../bot/services/list-check/ocr.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: config } = await import('../bot/config.js');
const { COLORS } = await import('../bot/utils/ui.js');

const cardOf = payload => payload.embeds[0].toJSON();
const fieldPairs = card => (card.fields || []).map(({ name, value }) => [name, value]);

function queueFullError() {
  return Object.assign(new Error('OCR queue full'), { code: OCR_QUEUE_FULL_CODE, limit: 3 });
}

function mockVietnamese(context) {
  clearUserLanguageCache();
  context.mock.method(UserPreference, 'findOne', () => ({
    collation() { return this; },
    lean: async () => ({ language: 'vi' }),
  }));
  context.after(() => clearUserLanguageCache());
}

function slashInteraction(values) {
  const edits = [];
  return {
    edits,
    user: { id: 'check-user' }, guild: { id: 'guild' }, guildId: 'guild',
    values,
    options: { getAttachment: () => ({ url: 'https://example.test/a.png' }), getString: () => null },
    deferReply: async () => {},
    editReply: async payload => { edits.push(payload); },
  };
}

function checkHandlers(extractNamesFromImageFn) {
  return createCheckHandlers({ client: {}, extractNamesFromImageFn, getUserOcrModeFn: async () => 'daily' });
}

test('/la-check: a full OCR queue is a busy notice with the queue field and the retry tip', async context => {
  mockVietnamese(context);
  const interaction = slashInteraction();
  await checkHandlers(async () => { throw queueFullError(); }).handleListCheckCommand(interaction);

  const card = cardOf(interaction.edits[0]);
  assert.equal(card.title, '🚦  Bộ đọc ảnh đang kín lượt');
  assert.equal(card.color, COLORS.warning);
  assert.deepEqual(fieldPairs(card), [['🚦 Hàng chờ', '3/3 lượt']]);
  assert.equal(card.footer.text, '💡 Lượt này không bị giữ lại, cậu gửi lại ảnh khi hàng vơi nhé');
});

test('/la-check: an image with no names is an empty notice', async context => {
  mockVietnamese(context);
  const interaction = slashInteraction();
  await checkHandlers(async () => []).handleListCheckCommand(interaction);

  const card = cardOf(interaction.edits[0]);
  assert.ok(card.title.startsWith('🔍  '), card.title);
  assert.equal(card.color, COLORS.info);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
});

test('/la-check: the checking notice is a progress notice with no bar, and a broken check is a failure with its detail', async context => {
  mockVietnamese(context);
  context.mock.method(mongoose, 'connect', async () => { throw new Error('db down'); });
  const interaction = slashInteraction();
  await checkHandlers(async () => ['Alicea', 'Bobbyb']).handleListCheckCommand(interaction);

  const progress = cardOf(interaction.edits[0]);
  assert.ok(progress.title.startsWith('⏳  '), progress.title);
  assert.equal(progress.color, COLORS.info);
  assert.match(progress.description, /\*\*2\*\*/);
  assert.doesNotMatch(progress.description, /[█░▰▱]/);

  const failure = cardOf(interaction.edits[1]);
  assert.ok(failure.title.startsWith('❌  '), failure.title);
  assert.equal(failure.color, COLORS.danger);
  assert.deepEqual(fieldPairs(failure), [['🧾 Chi tiết', '`db down`']]);
});

test('/la-check: a details pick that maps to no entry is an expired notice', async context => {
  mockVietnamese(context);
  const interaction = slashInteraction(['not-an-entry-ref']);
  await checkHandlers(async () => []).handleAutoCheckEvidenceSelect(interaction);

  const card = cardOf(interaction.edits[0]);
  assert.ok(card.title.startsWith('⌛  '), card.title);
  assert.equal(card.color, COLORS.muted);
});

test('/la-check-mode: an unavailable Analysis mode is busy and a saved mode is done with a tip', async () => {
  const saved = config.geminiAnalysisModels;
  const run = async (mode, models) => {
    config.geminiAnalysisModels = models;
    const edits = [];
    await createOcrModeCommandHandler({
      connectDBFn: async () => {},
      getUserLanguageFn: async () => 'vi',
      getUserOcrModeFn: async () => 'daily',
      setUserOcrModeFn: async (_id, value) => value,
    })({
      user: { id: 'mode-user' },
      options: { getString: () => mode },
      deferReply: async () => {},
      editReply: async payload => { edits.push(payload); },
    });
    return cardOf(edits[0]);
  };
  try {
    const unavailable = await run('analysis', []);
    assert.ok(unavailable.title.startsWith('🚦  '), unavailable.title);
    assert.equal(unavailable.color, COLORS.warning);

    const done = await run('daily', ['model']);
    assert.ok(done.title.startsWith('✅  '), done.title);
    assert.equal(done.color, COLORS.success);
    assert.ok(done.footer.text.startsWith('💡 '), done.footer.text);
  } finally {
    config.geminiAnalysisModels = saved;
  }
});

function autoMessage({ content = '', images = [] } = {}) {
  const replies = [];
  const edits = [];
  return {
    replies,
    edits,
    id: `auto-${Math.random()}`,
    content,
    channelId: 'channel',
    guild: { id: 'guild' },
    author: { id: 'auto-user', bot: false, tag: 'User#0001' },
    attachments: new Collection(images.map((image, index) => [`image-${index}`, image])),
    channel: { name: 'loa-check' },
    reactions: { cache: { get: () => null } },
    react: async () => {},
    reply: async payload => {
      replies.push(payload);
      return { edit: async next => { edits.push(next); } };
    },
  };
}

function autoHandler(deps = {}) {
  resetAutoCheckDedupeForTest();
  return createAutoCheckMessageHandler({
    client: { user: { id: 'bot' } },
    imageChecksEnabled: true,
    isAutoCheckChannelFn: async () => true,
    getGuildLanguageFn: async () => 'vi',
    getUserOcrModeFn: async () => 'daily',
    buildAutoCheckEvidenceRowFn: () => null,
    ...deps,
  });
}

const png = id => ({ id, contentType: 'image/png', url: `https://example.test/${id}.png` });

test('auto-check: text with non-name tokens is an input notice listing the tokens', async () => {
  const message = autoMessage({ content: 'check https://example.com <@123>' });
  await autoHandler({ imageChecksEnabled: false })(message);

  const card = cardOf(message.replies[0]);
  assert.equal(card.title, '✏️  Mấy cái này không giống tên character');
  assert.equal(card.color, COLORS.warning);
  assert.deepEqual(fieldPairs(card), [['✏️ Không đọc được', '`https://example.com` · `<@123>`']]);
  assert.equal(card.footer.text, '💡 Sau "check" chỉ gửi tên character thôi nhé');
});

test('auto-check: a partly read image batch adds a partial notice naming the unread images', async () => {
  const message = autoMessage({ images: [png('a'), png('b')] });
  await autoHandler({
    extractNamesFromImageFn: async image => {
      if (image.id === 'b') throw new Error('unreadable');
      return ['Alicea'];
    },
    checkNamesAgainstListsFn: async names => names.map(name => ({ name, identityVerified: true, blackEntry: { name } })),
    formatCheckResultsFn: () => ['line'],
    buildListCheckEmbedFn: () => ({ embed: { title: 'result' } }),
  })(message);

  const partial = message.edits.at(-1).embeds[1].toJSON();
  assert.ok(partial.title.startsWith('⚠️  '), partial.title);
  assert.equal(partial.color, COLORS.warning);
  assert.deepEqual(fieldPairs(partial), [['🖼️ Ảnh chưa đọc được', '#2']]);
  assert.ok(partial.footer.text.startsWith('💡 '), partial.footer.text);
  assert.ok(partial.timestamp);
});

test('auto-check: the reading notice is a progress notice', async () => {
  const message = autoMessage({ images: [png('a')] });
  await autoHandler({
    extractNamesFromImageFn: async () => [],
  })(message);

  const progress = cardOf(message.replies[0]);
  assert.ok(progress.title.startsWith('⏳  '), progress.title);
  assert.equal(progress.color, COLORS.info);
  assert.match(progress.description, /\*\*1\/1\*\*/);
});

test('auto-check: a full OCR queue is busy and a broken check is a failure with its detail', async () => {
  const busy = autoMessage({ images: [png('a')] });
  await autoHandler({ extractNamesFromImageFn: async () => { throw queueFullError(); } })(busy);
  const busyCard = cardOf(busy.edits.at(-1));
  assert.ok(busyCard.title.startsWith('🚦  '), busyCard.title);
  assert.deepEqual(fieldPairs(busyCard), [['🚦 Hàng chờ', '3/3 lượt']]);

  const broken = autoMessage({ content: 'check Alicea' });
  await autoHandler({
    imageChecksEnabled: false,
    checkNamesAgainstListsFn: async () => { throw new Error('lists down'); },
  })(broken);
  const failure = cardOf(broken.edits.at(-1));
  assert.ok(failure.title.startsWith('❌  '), failure.title);
  assert.equal(failure.color, COLORS.danger);
  assert.deepEqual(fieldPairs(failure), [['🧾 Chi tiết', '`lists down`']]);
});
