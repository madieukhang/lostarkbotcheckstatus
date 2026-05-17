import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  renderTrackedAltsField,
  statMapFromRosterCharacters,
} = await import('../bot/handlers/list/trackedAltsRender.js');

test('tracked alts renderer preserves comma-formatted item levels', () => {
  const field = renderTrackedAltsField({
    names: ['Main', 'Altone'],
    primaryName: 'Main',
    statMap: statMapFromRosterCharacters([
      { name: 'Altone', className: 'Bard', itemLevel: '1,745.00', combatScore: '4501.38' },
    ]),
  });

  assert.match(field.value, /`1745\.00`/);
  assert.match(field.value, /CP `4501\.38`/);
});
