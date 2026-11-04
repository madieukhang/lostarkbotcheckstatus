import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/offline-test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.OFFICER_APPROVER_IDS = 'officer-1';

const { default: config } = await import('../bot/config.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { disconnectDB } = await import('../bot/db.js');
const { t, clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { COLORS } = await import('../bot/utils/ui.js');
const { dispatchComponentInteraction } = await import('../bot/app/interaction-router.js');
const { rejectNonSenior } = await import('../bot/utils/seniorGate.js');
const { buildStrongholdScanLimitEmbed } = await import('../bot/utils/strongholdScanGate.js');
const { createSystemHandlers } = await import('../bot/handlers/system/index.js');
const { handleSyncImagesAction } = await import('../bot/handlers/setup/syncImages.js');
const { handleRosterCommand, runRosterLookup } = await import('../bot/handlers/roster/command.js');
const { handleRosterDeepContinueButton } = await import('../bot/handlers/roster/deepContinue.js');
const { buildDeepScanStoppedNotice } = await import('../bot/handlers/roster/deepResult.js');
const { createRosterContinuationSession, clearRosterDeepSession } = await import('../bot/utils/rosterDeepSession.js');

const fieldPairs = (card) => (card.fields || []).map(({ name, value }) => [name, value]);

function mockEnglishViewer(context) {
  clearUserLanguageCache();
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  context.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function recorder(extra = {}) {
  const sent = [];
  return {
    sent,
    interaction: {
      user: { id: 'stranger-1' },
      deferReply: async () => {},
      deferUpdate: async () => {},
      reply: async (payload) => { sent.push(payload); },
      editReply: async (payload) => { sent.push(payload); },
      ...extra,
    },
  };
}

test('router: an unexpected handler error renders a failure with its details', async (context) => {
  context.mock.method(console, 'error', () => {});
  const { sent, interaction } = recorder({
    customId: 'boom:1',
    deferred: false,
    replied: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
  });

  await dispatchComponentInteraction(interaction, {
    buttonRoutes: [{ prefix: 'boom:', prefixes: ['boom:'], label: 'boom', handle: async () => { throw new Error('kaboom'); } }],
    selectRoutes: [],
    modalRoutes: [],
    autocompleteRoutes: {},
  });

  const card = sent[0].embeds[0].toJSON();
  const copy = t('dialogue.common.unexpected', 'en');
  assert.equal(card.title, `❌  ${copy.title}`);
  assert.equal(card.color, COLORS.danger);
  assert.deepEqual(fieldPairs(card), [['🧾 Details', '`kaboom`']]);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('senior gate: a non-senior caller gets a guard notice', async () => {
  const { sent, interaction } = recorder();
  assert.equal(await rejectNonSenior(interaction, 'en', 'dialogue.system.seniorOnly'), true);
  const card = sent[0].embeds[0].toJSON();
  assert.equal(card.title, `🔒  ${t('dialogue.system.seniorOnly', 'en').title}`);
  assert.equal(card.color, COLORS.warning);
});

test('scan limit: a refused second scan is busy and names the running one', () => {
  const copy = t('dialogue.scan.limit', 'en');
  const card = buildStrongholdScanLimitEmbed({ label: '/la-roster deep Alpha' }, 'en').toJSON();
  assert.equal(card.title, `🚦  ${copy.title}`);
  assert.equal(card.color, COLORS.warning);
  assert.deepEqual(fieldPairs(card), [[copy.runningField, '`/la-roster deep Alpha`']]);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);

  const unnamed = buildStrongholdScanLimitEmbed(null, 'en').toJSON();
  assert.deepEqual(fieldPairs(unnamed), []);
});

test('/la-status: a failed status read is a failure with its details', async (context) => {
  context.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'vi' }) }));
  clearUserLanguageCache();
  context.after(() => clearUserLanguageCache());
  const { sent, interaction } = recorder({ user: { id: 'anyone-1' } });
  const handlers = createSystemHandlers({
    client: {},
    connectDBFn: async () => {},
    resetState: async () => {},
    checkStatus: async () => { throw new Error('status down'); },
  });

  await handlers.handleStatusCommand(interaction);

  const card = sent[0].embeds[0].toJSON();
  const copy = t('dialogue.system.status.failed', 'vi');
  assert.equal(card.title, `❌  ${copy.title}`);
  assert.deepEqual(fieldPairs(card), [['🧾 Chi tiết', '`status down`']]);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('/la-reset: the cleared state is a done notice', async (context) => {
  context.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  context.after(() => clearUserLanguageCache());
  const { sent, interaction } = recorder({ user: { id: 'senior-1' } });
  const handlers = createSystemHandlers({
    client: {}, connectDBFn: async () => {}, checkStatus: async () => new Map(), resetState: async () => {},
  });

  await handlers.handleResetCommand(interaction);

  const card = sent[0].embeds[0].toJSON();
  assert.equal(card.title, `✅  ${t('dialogue.system.reset', 'en').title}`);
  assert.equal(card.color, COLORS.success);
});

test('/la-remote syncimages: a missing evidence channel is an input notice with a tip', async (context) => {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'sync-images-owner';
  context.after(() => { config.ownerGuildId = ownerGuildId; });
  context.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({}) }));
  const { sent, interaction } = recorder({ deferred: true });

  await handleSyncImagesAction(interaction, 'en');

  const card = sent[0].embeds[0].toJSON();
  const copy = t('dialogue.syncImages.missingChannel', 'en');
  assert.equal(card.title, `✏️  ${copy.title}`);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('/la-roster deep:true from a non-officer is a guard naming who can use it', async (context) => {
  mockEnglishViewer(context);
  const { sent, interaction } = recorder({
    options: {
      getString: () => 'Alpha',
      getBoolean: () => true,
      getInteger: () => null,
    },
  });

  await handleRosterCommand(interaction);

  const card = sent[0].embeds[0].toJSON();
  const copy = t('dialogue.roster.deepRestricted', 'en');
  assert.equal(card.title, `🔒  ${copy.title}`);
  assert.deepEqual(fieldPairs(card), [['👥 Who can use it', 'Officer · Senior']]);
  assert.equal(card.footer?.text, `💡 ${copy.tip}`);
});

test('/la-roster lookup: a failed fetch is a failure with its details', async () => {
  const edits = [];
  const fail = () => { throw Object.assign(new Error('bible 503'), { rosterStage: 'fetch' }); };
  assert.equal(await runRosterLookup({
    name: 'Alpha', guildId: 'guild', lang: 'en',
    replyEditor: { edit: async (payload) => edits.push(payload) },
  }, { fetchRoster: fail, renderVisible: fail }), false);

  const card = edits[0].embeds[0].toJSON();
  assert.equal(card.title, `❌  ${t('dialogue.roster.fetchFailed', 'en').title}`);
  assert.deepEqual(fieldPairs(card), [['🧾 Details', '`bible 503`']]);
});

const CONTINUE_ACCESS_CASES = [
  { cause: 'a missing session', clickerId: 'owner-1', session: false, key: 'dialogue.scan.sessionExpired', icon: '⌛', color: COLORS.muted },
  { cause: 'another caller', clickerId: 'other-1', session: true, key: 'dialogue.scan.notYourSession', icon: '🔒', color: COLORS.warning },
  { cause: 'a running continuation', clickerId: 'owner-1', session: true, inProgress: true, key: 'dialogue.scan.continueRunning', icon: '🚦', color: COLORS.warning },
];

for (const accessCase of CONTINUE_ACCESS_CASES) {
  test(`/la-roster Continue refused for ${accessCase.cause} uses ${accessCase.key}`, async (context) => {
    mockEnglishViewer(context);
    const session = accessCase.session
      ? createRosterContinuationSession({
        callerId: 'owner-1', targetName: 'Targetname', isHidden: false,
        meta: { guildName: '' }, guildMembers: [], altResult: {}, cap: 10,
        primaryEmbedJSON: { title: 'Original roster' },
      })
      : null;
    if (session) {
      session.inProgress = Boolean(accessCase.inProgress);
      context.after(() => clearRosterDeepSession(session.sessionId));
    }
    const { sent, interaction } = recorder({
      user: { id: accessCase.clickerId },
      customId: `roster-deep:continue:${session?.sessionId || 'missing'}`,
    });

    await handleRosterDeepContinueButton(interaction);

    const card = sent[0].embeds[0].toJSON();
    assert.equal(card.title, `${accessCase.icon}  ${t(accessCase.key, 'en').title}`);
    assert.equal(card.color, accessCase.color);
  });
}

test('a stopped deep scan is busy, with the retry step as a tip or the roster note in the description', () => {
  const copy = t('dialogue.scan.stopped', 'en', { name: 'Alpha', reason: 'rate limited' });

  const retry = buildDeepScanStoppedNotice({
    name: 'Alpha', error: new Error('rate limited'), lang: 'en', tip: copy.retry,
  }).toJSON();
  assert.equal(retry.title, `🚦  ${copy.title}`);
  assert.equal(retry.description, copy.description);
  assert.equal(retry.footer?.text, `💡 ${copy.retry}`);

  const hidden = buildDeepScanStoppedNotice({
    name: 'Alpha', error: new Error('rate limited'), lang: 'en', note: copy.rosterStillShown,
  }).toJSON();
  assert.equal(hidden.description, `${copy.description} ${copy.rosterStillShown}`);
  assert.equal(hidden.footer, undefined);

  const unknown = buildDeepScanStoppedNotice({ name: 'Alpha', error: null, lang: 'en' }).toJSON();
  assert.ok(unknown.description.includes(t('dialogue.scan.unexpectedError', 'en')), unknown.description);
});
