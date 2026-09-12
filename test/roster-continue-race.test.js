import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { setImmediate } from 'node:timers/promises';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/offline-test';

const { default: config } = await import('../bot/config.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { disconnectDB } = await import('../bot/db.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { handleRosterDeepContinueButton } = await import('../bot/handlers/roster/deepContinue.js');
const { createRosterContinuationSession, clearRosterDeepSession } = await import('../bot/utils/rosterDeepSession.js');

function prepare(t, callerId) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const oldOfficers = config.officerApproverIds;
  config.officerApproverIds = [...oldOfficers, callerId];
  clearUserLanguageCache();
  const session = createRosterContinuationSession({
    callerId, targetName: 'Targetname', isHidden: false,
    meta: { guildName: '' }, guildMembers: [], altResult: {}, cap: 10,
    primaryEmbedJSON: { title: 'Original roster' },
  });
  t.after(async () => {
    config.officerApproverIds = oldOfficers;
    clearUserLanguageCache();
    clearRosterDeepSession(session.sessionId);
    await disconnectDB();
  });
  return session;
}

function click(session, overrides = {}) {
  return {
    customId: `roster-deep:continue:${session.sessionId}`,
    user: { id: session.callerId },
    deferUpdate: async () => {}, editReply: async () => null, reply: async () => {},
    ...overrides,
  };
}

test('parallel-scan permission cannot start two continuations of the same session during acknowledgement', async t => {
  const session = prepare(t, 'continue-race-officer');
  let releaseAck;
  const pendingAck = new Promise(resolve => { releaseAck = resolve; });
  let firstAck;
  const entered = new Promise(resolve => { firstAck = resolve; });
  let acknowledgements = 0;
  let rejected = 0;
  const interaction = () => click(session, {
    deferUpdate: async () => { acknowledgements++; firstAck(); await pendingAck; },
    reply: async () => { rejected++; },
  });
  const first = handleRosterDeepContinueButton(interaction());
  await entered;
  const second = handleRosterDeepContinueButton(interaction());
  await setImmediate();
  releaseAck();
  await Promise.all([first, second]);
  assert.equal(acknowledgements, 1);
  assert.equal(rejected, 1);
  assert.equal(session.inProgress, false);
});

test('a continuation setup failure releases its session flag for retry', async t => {
  const session = prepare(t, 'continue-failed-officer');
  Object.defineProperty(session, 'primaryEmbedJSON', {
    configurable: true, get() { throw new Error('snapshot unavailable'); },
  });
  await assert.rejects(handleRosterDeepContinueButton(click(session)), /snapshot unavailable/);
  assert.equal(session.inProgress, false);
  Object.defineProperty(session, 'primaryEmbedJSON', { value: { title: 'Recovered roster' } });
  let acknowledged = false;
  await handleRosterDeepContinueButton(click(session, { deferUpdate: async () => { acknowledged = true; } }));
  assert.equal(acknowledged, true);
});

test('failed acknowledgement leaves the continuation available to retry', async t => {
  const session = prepare(t, 'continue-ack-officer');
  await assert.rejects(handleRosterDeepContinueButton(click(session, {
    deferUpdate: async () => { throw new Error('Unknown interaction'); },
  })), /Unknown interaction/);
  assert.equal(session.inProgress, false);
  await handleRosterDeepContinueButton(click(session));
  assert.equal(session.inProgress, false);
});

test('officers can still continue two different sessions in parallel', async t => {
  const firstSession = prepare(t, 'continue-parallel-officer');
  const secondSession = createRosterContinuationSession({
    callerId: firstSession.callerId, targetName: 'Secondname', isHidden: false,
    meta: { guildName: '' }, guildMembers: [], altResult: {}, cap: 10,
    primaryEmbedJSON: { title: 'Second roster' },
  });
  t.after(() => clearRosterDeepSession(secondSession.sessionId));
  let acknowledgements = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = [firstSession, secondSession].map(session => handleRosterDeepContinueButton(click(session, {
    deferUpdate: async () => { if (++acknowledgements === 2) release(); await barrier; },
  })));
  await Promise.all(pending);
  assert.equal(acknowledgements, 2);
  assert.equal(firstSession.inProgress, false);
  assert.equal(secondSession.inProgress, false);
});
