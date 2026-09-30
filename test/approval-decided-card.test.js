import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import { createListAddApprovalButtonHandler } from '../bot/handlers/list/add/approvalButton.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { disconnectDB } from '../bot/db.js';
import { mockPendingApprovalModel } from './helpers/pending-approval-model.js';

const PAYLOAD = {
  requestId: 'decided', action: 'add', name: 'Burgerxucxich', type: 'black', scope: 'global',
  raid: 'Kazeros Hard', reason: 'Left Kazeros Hard G2 after the first wipe.',
  guildId: 'origin-guild', requestedByUserId: 'requester', requestedByDisplayName: 'Rainfox',
  imageUrl: 'https://cdn.example/evidence.png', approverIds: ['approver'],
};

async function decide(t, action, executeListAddToDatabase = async () => ({ ok: true })) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  mockPendingApprovalModel(t, PendingApproval, PAYLOAD);

  const edits = [];
  const handler = createListAddApprovalButtonHandler({
    executeListAddToDatabase,
    syncApproverDmMessages: async () => {},
    notifyRequesterAboutDecision: async () => {},
  });
  await handler({
    customId: `listadd_${action}:decided`, user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
    client: { guilds: { cache: new Map([['origin-guild', { name: 'Thaemine Nightwatch' }]]) } },
    deferUpdate: async () => {}, editReply: async (payload) => { edits.push(payload); },
    reply: async () => {}, followUp: async () => {},
  });
  const final = edits.at(-1);
  return { final, embed: final.embeds[0].toJSON() };
}

const fieldNames = (embed) => embed.fields.map((field) => field.name);

for (const [action, outcome, line] of [
  ['approve', 'Approved', /Approved and saved by \*\*aurel\*\*/],
  ['reject', 'Rejected', /Rejected by \*\*aurel\*\*/],
]) {
  test(`an approver DM keeps the request after it is ${outcome.toLowerCase()}`, async (t) => {
    const { final, embed } = await decide(t, action);

    assert.match(embed.title, new RegExp(`Add approval · Burgerxucxich · ${outcome}$`));
    assert.match(embed.description, /A member of \*\*Thaemine Nightwatch\*\* asked to add/);
    const names = fieldNames(embed);
    for (const kept of ['📝 Reason', '👤 Requested by', '🆔 Request ID']) {
      assert.ok(names.includes(kept), `missing ${kept}`);
    }
    const decision = embed.fields.at(-1);
    assert.equal(decision.name, '🛡️ Decision');
    assert.match(decision.value, line);
    assert.match(decision.value, /<t:\d+:R>/);
    // Deciding deletes the pending request, so its evidence link and button
    // would stop working.
    assert.equal(embed.image, undefined);
    assert.ok(!names.some((name) => /Evidence/i.test(name)));
    assert.equal(final.components.length, 1);
    assert.equal(final.components[0].toJSON().components.length, 1);
    assert.equal(final.components[0].toJSON().components[0].disabled, true);
  });
}

test('an approval the executor turned down says why on the kept card', async (t) => {
  const { embed } = await decide(t, 'approve', async () => ({ ok: false, content: 'Burgerxucxich is on the Trusted list.' }));

  assert.match(embed.title, /· Not added$/);
  assert.match(embed.fields.at(-1).value, /but I could not add it: Burgerxucxich is on the Trusted list\./);
});
