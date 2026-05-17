import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');
const {
  buildTrackedAltsField,
  formatBroadcastCharacterLine,
  mergeRosterStatRecords,
} = await import('../bot/handlers/list/services/broadcasts.js');

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
