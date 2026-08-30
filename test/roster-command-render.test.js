import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { formatVisibleRosterLine } = await import('../bot/handlers/roster/command.js');

test('/la-roster renders CP as a code badge with the unit after the score', () => {
  const line = formatVisibleRosterLine({
    name: 'Aresvn',
    itemLevel: '1790',
    combatScore: '≈6180.57',
  }, 0, {
    classPrefix: '<:paladin:42>',
    delta: ' *(+10.00)*',
  });

  assert.equal(
    line,
    '**1.** <:paladin:42> Aresvn · `1790` *(+10.00)* · `≈6180.57 CP`'
  );
});
