import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildBroadcastPayload } = await import('../bot/handlers/list/services/broadcasts.js');

const BEFORE_EDIT = Object.freeze({
  name: 'Main',
  reason: 'Old reason',
  raid: 'Aegir',
  scope: 'global',
  allCharacters: ['Main', 'Alt'],
  imageMessageId: '111',
  imageChannelId: '900',
  addedAt: new Date('2026-08-30T00:00:00Z'),
});

test('an edit broadcast marks what changed in place and names the rest in its headline', () => {
  const { embeds, components } = buildBroadcastPayload({
    action: 'edited',
    entry: {
      ...BEFORE_EDIT,
      reason: 'New reason',
      allCharacters: ['Main', 'Alt', 'Newalt'],
      imageMessageId: '222',
    },
    type: 'black',
    statMap: new Map(),
    previousEntry: BEFORE_EDIT,
    lang: 'en',
  });
  const card = embeds[0].toJSON();

  assert.equal(card.title, '✏️ Blacklist · Updated · Main');
  assert.match(card.description, / · changed \*\*Reason\*\*, \*\*Evidence\*\* · added \*\*1\*\* alt\.$/);
  assert.equal(card.fields[0].name, '📝 Reason ✏️');
  assert.equal(card.fields.find((field) => field.name.startsWith('🗡️')).name, '🗡️ Raid');
  assert.equal(card.fields.some((field) => field.name.startsWith('🔁')), false);
  assert.match(card.fields.at(-1).value, /Newalt\/roster\) 🆕/);
  assert.doesNotMatch(card.fields.at(-1).value, /\/Alt\/roster\) 🆕/);
  // The card shows no image, so a replaced one is pointed at the button.
  assert.match(card.footer.text, /^📎/);
  assert.equal(components.length, 1);
});

test('an add broadcast is titled like the /la-list add card and has no footer', () => {
  const { embeds } = buildBroadcastPayload({
    action: 'added',
    entry: BEFORE_EDIT,
    type: 'black',
    statMap: new Map(),
    lang: 'en',
  });
  const card = embeds[0].toJSON();

  assert.equal(card.title, '⛔ Blacklist · Added · Main');
  assert.match(card.description, /was added to the \*\*Blacklist\*\*\.$/);
  assert.equal(card.footer, undefined);
});
