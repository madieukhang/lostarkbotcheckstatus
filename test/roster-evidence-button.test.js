import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MessageFlags } from 'discord.js';
import Blacklist from '../bot/models/Blacklist.js';
import Watchlist from '../bot/models/Watchlist.js';
import UserPreference from '../bot/models/UserPreference.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { buildScopedListQuery } from '../bot/utils/scope.js';
import { handleRosterEvidenceButton } from '../bot/handlers/roster/evidenceButton.js';

function mockViewer(t) {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
}

function buttonClick(customId) {
  const click = {
    customId, user: { id: 'viewer' }, guild: { id: 'other-guild' }, guildId: 'other-guild', client: {},
    deferred: null, replies: [],
    deferReply: async (options) => { click.deferred = options; },
    editReply: async (payload) => { click.replies.push(payload); },
  };
  return click;
}

const replyText = (click) => JSON.stringify(click.replies.at(-1).embeds[0].toJSON());

test('a /la-roster report button shows the full report to the clicker only', async t => {
  mockViewer(t);
  const entry = { _id: 'c'.repeat(24), name: 'Burgerxúcxích', reason: 'vua ngủ gật', allCharacters: ['Hailúa', 'Burgerxúcxích'] };
  const queries = [];
  t.mock.method(Watchlist, 'findOne', (query) => {
    queries.push(query);
    return { lean: async () => entry };
  });

  const click = buttonClick(`roster_evidence:watch:${entry._id}`);
  await handleRosterEvidenceButton(click);

  assert.deepEqual(click.deferred, { flags: MessageFlags.Ephemeral });
  assert.deepEqual(queries, [buildScopedListQuery('watch', { _id: entry._id }, 'other-guild')]);
  assert.match(replyText(click), /vua ngủ gật/u);
});

test('a /la-roster report button hides a blacklist entry outside the clicker server', async t => {
  mockViewer(t);
  const entry = {
    _id: 'a'.repeat(24), name: 'Privacycase', scope: 'server', guildId: 'private-guild',
    reason: 'PRIVATE_REASON_AFTER_SCOPE_CHANGE',
  };
  const queries = [];
  t.mock.method(Blacklist, 'findOne', (query) => {
    queries.push(query);
    // Visible by id alone, excluded by the scoped query.
    return { lean: async () => (query.$and ? null : entry) };
  });

  const click = buttonClick(`roster_evidence:black:${entry._id}`);
  await handleRosterEvidenceButton(click);

  assert.deepEqual(queries, [buildScopedListQuery('black', { _id: entry._id }, 'other-guild')]);
  assert.doesNotMatch(replyText(click), /PRIVATE_REASON_AFTER_SCOPE_CHANGE/);
});

test('a malformed /la-roster report button reads no list', async t => {
  mockViewer(t);
  t.mock.method(Blacklist, 'findOne', () => assert.fail('a malformed id must not reach the list'));

  const click = buttonClick('roster_evidence:black:not-an-id');
  await handleRosterEvidenceButton(click);

  assert.equal(click.replies.length, 1);
});
