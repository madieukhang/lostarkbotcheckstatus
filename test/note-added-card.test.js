import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteAddedPayload } from '../bot/handlers/list/notes/addedCard.js';

const AT = new Date('2026-07-02T00:00:00Z');
const entry = {
  _id: 'e'.repeat(24), name: 'Lovesiiii', scope: 'global', reason: 'vẫn thế', raid: 'Kazeros Hard',
  allCharacters: ['Lovesiiii', 'Pepsji'], imageMessageId: 'm', imageChannelId: 'c',
  notes: [
    { at: AT, reason: 'Đánh quá yếu', raid: 'Act4 Nor', byUserId: 'a', byName: 'KilZ' },
    { at: new Date(), reason: 'vẫn thế', raid: 'Kazeros Hard', byUserId: 'b', byName: 'meow' },
  ],
};

test('the Note added card shows the new note, who wrote it, new alts and the history', () => {
  const payload = buildNoteAddedPayload({ entry, type: 'black', addedAlts: ['Pepsji'], statMap: new Map(), lang: 'en' });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /Blacklist · Note added · Lovesiiii/);
  assert.equal(embed.fields[0].value, 'vẫn thế\n-# 📜 2 notes · first on 02 Jul 2026');
  assert.ok(embed.fields.some(field => field.value === 'meow'));
  assert.match(JSON.stringify(embed.fields), /Pepsji.*🆕/);
  assert.match(embed.footer.text, /1 new alt/);
  assert.deepEqual(payload.components[0].toJSON().components.map(button => button.custom_id), [
    `listnote_history:black:${'e'.repeat(24)}:1`, 'listbroadcast_evidence:c:m',
  ]);
});
