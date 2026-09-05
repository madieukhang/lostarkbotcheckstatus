import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache, t as translate } from '../bot/services/i18n/index.js';
import { createListAddApprovalButtonHandler } from '../bot/handlers/list/add/approvalButton.js';
import { COLORS } from '../bot/utils/ui.js';

async function renderDuplicate(t, { lang = 'en', direct = false, long = false, legacy = false } = {}) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: lang }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const existing = {
    _id: 'existing-id', name: 'Storedmain', scope: 'server',
    reason: long ? 'Stored report '.repeat(150) : 'Stored report',
    raid: 'Act4 Normal', addedAt: '2026-05-17T10:30:00Z', addedByDisplayName: 'Recorder',
  };
  const payload = {
    requestId: 'request-id', type: 'black', scope: 'global', guildId: 'guild',
    name: direct ? existing.name : 'Requestalt',
    reason: long ? 'New report '.repeat(180) : 'New report',
    raid: 'Kazeros Hard', requestedByDisplayName: 'Requester',
  };
  if (legacy) {
    delete existing.reason;
    delete existing.addedAt;
    delete existing.addedByDisplayName;
    payload.reason = '   ';
    payload.raid = '';
  }
  let storedDuplicateId;
  t.mock.method(PendingApproval, 'findOne', query => ({ lean: async () => {
    assert.equal(query.approverIds, 'approver');
    return payload;
  } }));
  t.mock.method(PendingApproval, 'updateOne', async (query, update) => {
    assert.equal(query.requestId, payload.requestId);
    storedDuplicateId = update.$set.duplicateEntryId;
  });
  t.mock.method(PendingApproval, 'deleteOne', () => assert.fail('A duplicate must remain pending until keep/overwrite'));
  const edits = [];
  const synced = [];
  let executions = 0;
  const handler = createListAddApprovalButtonHandler({
    client: {},
    executeListAddToDatabase: async () => { executions += 1; return { ok: false, isDuplicate: true, existingEntry: existing }; },
    syncApproverDmMessages: async (_payload, build, options) => {
      assert.equal(options.excludeMessageId, 'clicked');
      synced.push(build('jp'));
    },
    broadcastListChange: async () => assert.fail('Comparison must not broadcast'),
    notifyRequesterAboutDecision: async () => assert.fail('Comparison is not a final decision'),
  });
  await handler({
    customId: 'listadd_approve:request-id', user: { id: 'approver', tag: 'Approver' },
    message: { id: 'clicked' }, deferUpdate: async () => {},
    editReply: async value => edits.push(value),
  });
  assert.equal(executions, 1);
  assert.equal(storedDuplicateId, existing._id);
  return { card: edits.at(-1), peerCard: synced.at(-1), existing, payload };
}

for (const lang of ['en', 'vi', 'jp']) {
  for (const direct of [false, true]) {
    test(`${lang} approval comparison keeps full-width reasons and linked ${direct ? 'direct' : 'roster'} identities`, async t => {
      const { card, peerCard, existing, payload } = await renderDuplicate(t, { lang, direct });
      const embed = card.embeds[0].toJSON();
      assert.equal(embed.author.name, `⚠️ ${translate('dialogue.approval.flow.duplicateTitle', lang)}`);
      assert.equal(embed.title, undefined);
      assert.equal(embed.color, COLORS.warning);
      assert.deepEqual(embed.fields.slice(0, 2).map(field => [field.value, field.inline]), [
        [existing.reason, false], [payload.reason, false],
      ]);
      assert.match(embed.description, new RegExp(`\\[${payload.name}\\]\\(https://lostark\\.bible/character/NA/`));
      if (!direct) assert.match(embed.description, /\[Storedmain\]\(https:\/\/lostark\.bible\/character\/NA\//);
      assert.equal(embed.fields[2].inline, true);
      assert.equal(embed.fields[3].inline, true);
      assert.match(embed.fields[2].value, /Act4 Normal/);
      assert.match(embed.fields[3].value, /Kazeros Hard/);
      assert.ok(embed.fields[2].value.includes(translate('dialogue.approval.scopeTag.local', lang)));
      assert.ok(embed.fields[3].value.includes(translate('dialogue.approval.scopeTag.global', lang)));
      assert.match(embed.fields[2].value, /<t:1779013800:R>/);
      assert.match(embed.fields[3].value, /Requester/);
      assert.deepEqual(card.components[0].toJSON().components.map(button => button.custom_id), [
        'listadd_overwrite:request-id', 'listadd_keep:request-id',
      ]);
      assert.equal(peerCard.embeds[0].toJSON().author.name, `⚠️ ${translate('dialogue.approval.flow.duplicateTitle', 'jp')}`);
      assert.equal(peerCard.components[0].toJSON().components[1].label, translate('common.actions.keepExisting', 'jp'));
    });
  }
}

test('approval comparison fits long reasons without aborting the pending decision', async t => {
  const { card } = await renderDuplicate(t, { long: true });
  const embed = card.embeds[0].toJSON();
  assert.equal(embed.fields[0].value.length, 1024);
  assert.equal(embed.fields[1].value.length, 1024);
  assert.ok(embed.fields.every(field => field.value.length > 0 && field.value.length <= 1024));
  assert.ok(card.embeds[0].length <= 6000);
  assert.equal(card.components[0].toJSON().components.length, 2);
});

test('legacy comparison avoids epoch timestamps and explains omitted overwrite values', async t => {
  const { card } = await renderDuplicate(t, { legacy: true });
  const embed = card.embeds[0].toJSON();
  assert.doesNotMatch(JSON.stringify(embed), /<t:0:|NaN|undefined/);
  assert.match(embed.fields[1].value, /keep existing/i);
  assert.match(embed.fields[3].value, /keep existing/i);
});
