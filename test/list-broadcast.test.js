import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');
const {
  buildTrackedAltsField,
  formatBroadcastCharacterLine,
  hydrateBroadcastStatMap,
  mergeRosterStatRecords,
  sendEmbedToChannels,
} = await import('../bot/handlers/list/services/broadcasts.js');

test('broadcast snapshot hydration performs at most one roster fetch and persists the result', async () => {
  const persisted = [];
  let fetches = 0;
  const statMap = await hydrateBroadcastStatMap({
    entry: { name: 'Main', allCharacters: ['Main', 'Alt'] },
    initialRecords: [{ name: 'Alt', classId: 'blade', itemLevel: 1710 }],
    buildRosterCharactersFn: async () => {
      fetches += 1;
      return {
        hasValidRoster: true,
        rosterCharacters: [
          { name: 'Main', classId: 'bard', itemLevel: 1750 },
          { name: 'Alt', classId: 'blade', itemLevel: 1710 },
        ],
      };
    },
    upsertRosterSnapshotsFn: async (records, rosterName) => persisted.push([records, rosterName]),
  });

  assert.equal(fetches, 1);
  assert.equal(statMap.get('main').classId, 'bard');
  assert.equal(statMap.get('alt').classId, 'blade');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][1], 'Main');
});

test('list broadcast tracked alts include class icon, item level, and CP when known', () => {
  const oldBardEmoji = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard:1>';

  try {
    const statMap = mergeRosterStatRecords([
      { name: 'Elynnä', className: 'Bard', itemLevel: '1745', combatScore: '4501.38' },
    ]);

    const field = buildTrackedAltsField({
      name: 'Sphinx',
      allCharacters: ['Sphinx', 'Elynnä', 'NoSnap'],
    }, statMap);

    assert.equal(field.name, '🧬 Tracked alts (2)');
    // Numbering is now bold-prefixed (`**N.**`) since the broadcast
    // helper delegates to the shared trackedAltsRender · cross-surface
    // consistency with /la-list view evidence detail.
    assert.match(
      field.value,
      /\*\*1\.\*\* <:bard:1> \[Elynnä\]\(https:\/\/lostark\.bible\/character\/NA\/Elynn%C3%A4\/roster\) · `1745\.00` · CP `4501\.38`/
    );
    assert.match(
      field.value,
      /\*\*2\.\*\* \[NoSnap\]\(https:\/\/lostark\.bible\/character\/NA\/NoSnap\/roster\)/
    );
  } finally {
    CLASS_EMOJI_MAP.Bard = oldBardEmoji;
  }
});

test('list broadcast character lines fall back to class text when emoji is unavailable', () => {
  const line = formatBroadcastCharacterLine('AltName', 0, {
    name: 'AltName',
    className: 'Breaker',
    itemLevel: 1710.5,
    combatScore: '3920',
  });

  assert.equal(
    line,
    '**1.** Breaker [AltName](https://lostark.bible/character/NA/AltName/roster) · `1710.50` · CP `3920`'
  );
});

test('sendEmbedToChannels reuses one delivery path and isolates channel failures', async () => {
  const delivered = [];
  const warnings = [];
  const embed = { title: 'List changed' };
  const components = [{ type: 1, components: [] }];
  const client = {
    channels: {
      async fetch(channelId) {
        if (channelId === 'fetch-fails') throw new Error('missing channel');
        if (channelId === 'not-text') return { isTextBased: () => false };
        if (channelId === 'send-fails') {
          return {
            isTextBased: () => true,
            async send() { throw new Error('missing permission'); },
          };
        }
        return {
          isTextBased: () => true,
          async send(payload) { delivered.push([channelId, payload]); },
        };
      },
    },
  };

  await sendEmbedToChannels({
    client,
    channelIds: new Set(['ok', 'not-text', 'fetch-fails', 'send-fails']),
    embed,
    components,
    logLabel: '[test broadcast]',
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(delivered, [['ok', { embeds: [embed], components }]]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^\[test broadcast\] channel fetch-fails failed:/);
  assert.match(warnings[1], /^\[test broadcast\] channel send-fails failed:/);
});
