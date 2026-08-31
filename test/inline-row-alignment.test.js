import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildCheckEntryDetailsEmbed } = await import('../bot/handlers/list/check/ui.js');
const { buildBroadcastFields } = await import('../bot/handlers/list/services/broadcasts.js');
const { buildEvidenceEmbed, buildTrustedListEmbed } = await import('../bot/handlers/list/view/ui.js');
const { buildListEditSuccessEmbed, buildTrustedBlockEmbed, buildListAddApprovalEmbed } = await import('../bot/handlers/list/helpers.js');
const { decorateListEntry } = await import('../bot/handlers/list/helpers.js');

/**
 * Discord lays inline fields three to a row and divides each row evenly
 * between whatever it holds. That only reads as ragged once a card runs
 * to more than one row: 4 renders as three plus a stretched banner, 5 as
 * three plus a mismatched pair. Up to three is always fine, because one
 * row on its own divides evenly however many it holds.
 */
function assertWholeRows(label, fields) {
  const inlineCount = fields.filter((field) => field.inline).length;
  assert.ok(
    inlineCount <= 3 || inlineCount % 3 === 0,
    `${label}: ${inlineCount} inline fields leaves a ragged row`
  );
}

const ENTRY = {
  name: 'Tenshi',
  reason: 'Griefing report',
  raid: 'Kazeros Hard',
  addedAt: new Date('2026-08-30T00:00:00Z'),
  addedByDisplayName: 'meow',
  allCharacters: ['Tenshi', 'Hanako'],
  scope: 'global',
};
const SNAP = { name: 'Tenshi', className: 'Bard', itemLevel: 1770, combatScore: '≈4903.06', world: 'Thaemine' };

test('check detail card fills whole inline rows in every caller shape', () => {
  const statMap = new Map([['tenshi', SNAP]]);
  for (const includeAddedBy of [true, false]) {
    for (const snap of [statMap, new Map()]) {
      const embed = buildCheckEntryDetailsEmbed(
        decorateListEntry(ENTRY, 'black'),
        { lang: 'vi', includeAddedBy, statMap: snap }
      ).toJSON();
      assertWholeRows(`check detail (addedBy=${includeAddedBy}, snap=${snap.size})`, embed.fields);
    }
  }
});

test('broadcast fields fill whole inline rows for every optional combination', () => {
  const snaps = [
    { itemLevel: 1770, combatScore: '≈4903.06', world: 'Thaemine' },
    { itemLevel: 1770, combatScore: '≈4903.06' },
    { itemLevel: 1770 },
    {},
  ];
  for (const snap of snaps) {
    for (const raid of ['Kazeros Hard', '']) {
      for (const addedAt of [ENTRY.addedAt, null]) {
        const fields = buildBroadcastFields({
          entry: { ...ENTRY, raid, addedAt },
          action: 'added',
          snap,
          lang: 'vi',
        });
        assertWholeRows(`broadcast (raid=${!!raid}, added=${!!addedAt}, snap=${Object.keys(snap).length})`, fields);
      }
    }
  }
});

test('evidence card fills whole inline rows in both modes', () => {
  const statMap = new Map([['tenshi', SNAP]]);
  for (const headline of [true, false]) {
    for (const includeAddedBy of [true, false]) {
      for (const snap of [statMap, new Map()]) {
        const embed = buildEvidenceEmbed(decorateListEntry(ENTRY, 'black'), '', {
          lang: 'vi', headline, includeAddedBy, statMap: snap, attachImage: !headline,
        }).toJSON();
        assertWholeRows(`evidence (headline=${headline}, addedBy=${includeAddedBy})`, embed.fields);
      }
    }
  }
});

test('edit success and trusted cards fill whole inline rows', () => {
  for (const raid of ['Kazeros Hard', '']) {
    const embed = buildListEditSuccessEmbed({ ...ENTRY, raid }, {
      changes: ['x'], type: 'black', lang: 'vi', requesterDisplayName: 'meow',
    }).toJSON();
    assertWholeRows(`edit success (raid=${!!raid})`, embed.fields);
  }
  assertWholeRows('trusted block', buildTrustedBlockEmbed('Tenshi', 'reason', { lang: 'vi' }).toJSON().fields);
  assertWholeRows('trusted list', buildTrustedListEmbed([ENTRY], 'vi').toJSON().fields || []);
});

test('add approval card fills whole inline rows', () => {
  const embed = buildListAddApprovalEmbed(
    { id: 'g1', name: 'Guild' },
    { name: 'Tenshi', type: 'black', raid: 'Kazeros Hard', reason: 'r', scope: 'global', requestId: 'a'.repeat(24) },
    { lang: 'vi' }
  ).toJSON();
  assertWholeRows('add approval', embed.fields);
});
