import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { getUserOcrMode, setUserOcrMode } = await import('../bot/services/list-check/preferences.js');
const { createOcrModeCommandHandler } = await import('../bot/handlers/list/check/mode.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: config } = await import('../bot/config.js');
const { buildCommands } = await import('../bot/commands/index.js');
const { createCommandRoutes } = await import('../bot/app/interaction-router.js');

test('OCR preferences preserve user isolation, language and the Daily default', async () => {
  const documents = new Map([['alice', { language: 'jp' }], ['bob', { language: 'vi' }]]);
  const writes = [];
  const UserPreferenceModel = {
    findOne: ({ discordId }, projection) => {
      assert.deepEqual(projection, { ocrMode: 1 });
      return { lean: async () => documents.get(discordId) };
    },
    updateOne: async (filter, update, options) => {
      writes.push({ filter, update, options });
      documents.set(filter.discordId, { ...documents.get(filter.discordId), ...update.$set });
    },
  };
  const deps = { UserPreferenceModel };
  assert.equal(await getUserOcrMode('alice', deps), 'daily');
  assert.equal(await getUserOcrMode('new-user', deps), 'daily');
  assert.equal(await setUserOcrMode('alice', 'analysis', deps), 'analysis');
  assert.equal(await getUserOcrMode('alice', deps), 'analysis');
  assert.equal(await getUserOcrMode('bob', deps), 'daily');
  assert.equal(documents.get('alice').language, 'jp');
  assert.deepEqual(writes[0], {
    filter: { discordId: 'alice' }, update: { $set: { ocrMode: 'analysis' } },
    options: { upsert: true, runValidators: true },
  });
  await setUserOcrMode('alice', 'daily', deps);
  assert.equal(await getUserOcrMode('alice', deps), 'daily');
  await assert.rejects(setUserOcrMode('alice', 'unknown', deps), /Unknown OCR mode/);
  await assert.rejects(setUserOcrMode('', 'analysis', deps), /Discord user ID/);
  assert.equal(writes.length, 2);
  assert.equal(UserPreference.schema.path('ocrMode').defaultValue, 'daily');
  assert.deepEqual(UserPreference.schema.path('ocrMode').enumValues, ['daily', 'analysis']);
});

test('missing or unreadable preferences never select Analysis', async () => {
  assert.equal(await getUserOcrMode(null), 'daily');
  assert.equal(await getUserOcrMode('user', { UserPreferenceModel: {
    findOne: () => ({ lean: async () => ({ ocrMode: 'unexpected' }) }),
  } }), 'daily');
  assert.equal(await getUserOcrMode('user', { UserPreferenceModel: {
    findOne: () => ({ lean: async () => { throw new Error('offline'); } }),
  } }), 'daily');
});

test('/la-check-mode reads without a write and confirms a saved mode privately', async () => {
  const writes = [];
  const edits = [];
  const handler = createOcrModeCommandHandler({
    connectDBFn: async () => {},
    getUserLanguageFn: async () => 'en',
    getUserOcrModeFn: async id => { assert.equal(id, 'alice'); return 'daily'; },
    setUserOcrModeFn: async (id, mode) => { writes.push({ id, mode }); return mode; },
  });
  for (const mode of [null, 'analysis', 'daily']) {
    await handler({
      user: { id: 'alice' }, options: { getString: () => mode },
      deferReply: async payload => assert.equal(payload.flags, MessageFlags.Ephemeral),
      editReply: async payload => edits.push(payload.embeds[0].toJSON()),
    });
  }
  assert.deepEqual(writes, [{ id: 'alice', mode: 'analysis' }, { id: 'alice', mode: 'daily' }]);
  assert.match(edits[0].description, /Daily/);
  assert.match(edits[1].description, /Analysis/);
  assert.match(edits[2].description, /Daily/);
});

test('/la-check-mode never confirms success when saving fails or Analysis is disabled', async (t) => {
  const originalModels = config.geminiAnalysisModels;
  t.after(() => { config.geminiAnalysisModels = originalModels; });
  const edits = [];
  let writes = 0;
  const handler = createOcrModeCommandHandler({
    connectDBFn: async () => {}, getUserLanguageFn: async () => 'en',
    setUserOcrModeFn: async () => { writes += 1; throw new Error('write failed'); },
  });
  const interaction = {
    user: { id: 'alice' }, options: { getString: () => 'analysis' },
    deferReply: async () => {}, editReply: async payload => edits.push(payload.embeds[0].toJSON()),
  };
  await assert.rejects(handler(interaction), /write failed/);
  assert.deepEqual(edits, []);
  config.geminiAnalysisModels = [];
  await handler(interaction);
  assert.equal(writes, 1);
  assert.match(edits[0].title, /unavailable/);
});

test('/la-check-mode is registered and routed with an optional explicit mode', () => {
  const command = buildCommands().find(command => command.name === 'la-check-mode');
  assert.equal(command.options[0].required, false);
  assert.deepEqual(command.options[0].choices.map(choice => choice.value), ['daily', 'analysis']);
  assert.equal(typeof createCommandRoutes({ systemHandlers: {}, listHandlers: {} })['la-check-mode'], 'function');
});
