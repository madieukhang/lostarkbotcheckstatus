import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildHiddenRosterGuidance } = await import('../bot/handlers/list/services/addExecutor.js');

test('hidden roster add guidance offers enrich when bible exposes a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', 'Bullet Shell');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /Bible shows guild \*\*Bullet Shell\*\*/);
  assert.match(guidance.fields[0].value, /\/la-list enrich name:Ainslinn/);
  assert.equal(guidance.components.length, 1);
});

test('hidden roster add guidance avoids enrich button without a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', '');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /needs a visible guild member list/);
  assert.match(guidance.fields[0].value, /\/la-list edit name:Ainslinn additional_names:Alt1, Alt2/);
  assert.equal(guidance.components.length, 0);
});

