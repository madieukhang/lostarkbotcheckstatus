import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildEnrichSuccessEmbed } = await import('../bot/handlers/list/enrich/ui.js');
const { resolveScanCancelState } = await import('../bot/handlers/list/enrich/index.js');
const { resolveMultiaddConfirmState } = await import('../bot/handlers/list/multiadd/confirmButton.js');
const { findDuplicateEntry } = await import('../bot/handlers/list/add/overwriteButton.js');
const { formatDeepScanStats } = await import('../bot/handlers/roster/progress.js');
const { sendScanCompletionDm } = await import('../bot/utils/scanCompletionDm.js');

test('multiadd confirmation policy preserves expiry, ownership, and action priority', () => {
  const pending = { requesterId: 'requester' };

  assert.equal(resolveMultiaddConfirmState({
    prefix: 'multiadd_cancel',
    pending: null,
    userId: 'requester',
  }), 'expired');
  assert.equal(resolveMultiaddConfirmState({
    prefix: 'multiadd_cancel',
    pending,
    userId: 'intruder',
  }), 'not-yours');
  assert.equal(resolveMultiaddConfirmState({
    prefix: 'multiadd_cancel',
    pending,
    userId: 'requester',
  }), 'cancel');
  assert.equal(resolveMultiaddConfirmState({
    prefix: 'multiadd_confirm',
    pending,
    userId: 'requester',
  }), 'confirm');
  assert.equal(resolveMultiaddConfirmState({
    prefix: 'multiadd_unknown',
    pending,
    userId: 'requester',
  }), 'ignore');
});

test('scan cancellation policy keeps finished and permission states ordered', () => {
  const activeScan = { callerId: 'caller', cancelFlag: { cancelled: false } };
  const stoppingScan = { callerId: 'caller', cancelFlag: { cancelled: true } };

  assert.equal(resolveScanCancelState({ scan: null, userId: 'caller', isPrivileged: false }), 'finished');
  assert.equal(resolveScanCancelState({ scan: activeScan, userId: 'other', isPrivileged: false }), 'restricted');
  assert.equal(resolveScanCancelState({ scan: stoppingScan, userId: 'caller', isPrivileged: false }), 'already-stopping');
  assert.equal(resolveScanCancelState({ scan: activeScan, userId: 'caller', isPrivileged: false }), 'ready');
  assert.equal(resolveScanCancelState({ scan: activeScan, userId: 'officer', isPrivileged: true }), 'ready');
});

test('duplicate lookup strategy prefers id and keeps the blacklist fallback scope-aware', async () => {
  const directEntry = { _id: 'entry-direct' };
  let fallbackCalls = 0;
  const directModel = {
    findById: async (id) => id === 'entry-direct' ? directEntry : null,
    findOne: () => {
      fallbackCalls += 1;
      return { collation: async () => null };
    },
  };

  assert.equal(await findDuplicateEntry(directModel, {
    duplicateEntryId: 'entry-direct',
    name: 'Ainslinn',
    type: 'black',
    scope: 'server',
    guildId: 'guild-1',
  }), directEntry);
  assert.equal(fallbackCalls, 0);

  const fallbackEntry = { _id: 'entry-fallback' };
  let fallbackQuery;
  let fallbackCollation;
  const fallbackModel = {
    findById: async () => null,
    findOne: (query) => {
      fallbackQuery = query;
      return {
        collation: async (options) => {
          fallbackCollation = options;
          return fallbackEntry;
        },
      };
    },
  };

  assert.equal(await findDuplicateEntry(fallbackModel, {
    duplicateEntryId: 'stale-id',
    name: 'Ainslinn',
    type: 'black',
    scope: 'server',
    guildId: 'guild-1',
  }), fallbackEntry);
  assert.deepEqual(fallbackQuery.$and[1], { scope: 'server', guildId: 'guild-1' });
  assert.deepEqual(fallbackCollation, { locale: 'en', strength: 2 });
});

test('enrich success section pipeline retains optional source, hidden, and alt blocks', () => {
  const embed = buildEnrichSuccessEmbed({
    type: 'black',
    entryName: 'Ainslinn',
    targetIsHidden: true,
    scanStats: { guildName: 'AinsGuild' },
    newAlts: [{ name: 'Ainsalt', classId: 'bard', itemLevel: 1750 }],
  }, { matchedCount: 1, modifiedCount: 1 }, 'en').toJSON();

  assert.match(embed.description, /AinsGuild/);
  assert.match(embed.description, /hidden/i);
  assert.match(embed.description, /Ainsalt/);
});

test('deep scan metric table keeps optional metrics in display order', () => {
  const stats = formatDeepScanStats({
    checkedCandidates: 2,
    attemptedCandidates: 4,
    skippedCandidates: 1,
    failedCandidates: 2,
    concurrency: 3,
    usedScraperApiForCandidates: false,
  }, 'en');

  assert.match(stats, /2/);
  assert.ok(stats.indexOf('4') < stats.indexOf('1'));
  assert.ok(stats.indexOf('1') < stats.lastIndexOf('2'));
  assert.match(stats, /3/);
});

test('scan completion field pipeline includes each enabled optional block once', async () => {
  const payloads = [];
  const outcome = await sendScanCompletionDm({
    user: {
      id: 'user-1',
      send: async (payload) => { payloads.push(payload); },
    },
    commandLabel: '/la-roster deep',
    scanTargetName: 'Ainslinn',
    guildName: 'AinsGuild',
    resultMessageUrl: 'https://discord.com/channels/1/2/3',
    outcome: 'completed',
    result: {
      checkedCandidates: 2,
      attemptedCandidates: 4,
      failedCandidates: 1,
      scraperApiRequests: 3,
      abortLabel: 'manual stop',
      alts: [],
    },
    lang: 'en',
  });

  assert.deepEqual(outcome, { ok: true });
  assert.equal(payloads.length, 1);
  const embed = payloads[0].embeds[0].toJSON();
  assert.equal(embed.fields.length, 6);
  assert.equal(embed.fields.filter((field) => field.value === '4').length, 1);
  assert.equal(embed.fields.filter((field) => field.value === '3').length, 1);
  assert.equal(embed.fields.filter((field) => field.value === 'manual stop').length, 1);
  assert.equal(payloads[0].components.length, 1);
});
