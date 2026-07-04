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

test('tracked alts renderer defaults to the "🧬 Tracked alts" field label', () => {
  const field = renderTrackedAltsField({ names: ['Main', 'Altone'], primaryName: 'Main' });
  assert.equal(field.name, '🧬 Tracked alts (1)');
});

test('tracked alts renderer supports a custom label + class icon for the enrich "New alts" field', async () => {
  // The enrich broadcast reuses this renderer with label "🆕 New alts" so the
  // just-appended alts render with the SAME class icon + ilvl vocabulary as the
  // /la-list add card. Newly-discovered alts carry class/ilvl via the scan
  // session, fed in through statMapFromRosterCharacters.
  const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');
  const oldBard = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard:1>';
  try {
    const field = renderTrackedAltsField({
      names: ['Kirisys', 'Aeromai', 'Kirisol'],
      primaryName: 'Kirisys',
      statMap: statMapFromRosterCharacters([
        { name: 'Aeromai', className: 'Bard', itemLevel: '1720.00' },
      ]),
      label: '🆕 New alts',
    });
    // Primary (Kirisys) filtered out · only the two new alts counted.
    assert.equal(field.name, '🆕 New alts (2)');
    assert.match(field.value, /<:bard:1> \[Aeromai\]\(https:\/\/lostark\.bible\/character\/NA\/Aeromai\/roster\) · `1720\.00`/);
    assert.match(field.value, /\[Kirisol\]/);
  } finally {
    CLASS_EMOJI_MAP.Bard = oldBard;
  }
});
