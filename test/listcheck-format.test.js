import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCheckResults } from '../bot/services/list-check/format.js';

test('formatCheckResults sorts same-priority DPS before supports', () => {
  const lines = formatCheckResults([
    {
      name: 'Supportchar',
      blackEntry: { name: 'Supportchar', reason: 'bad', scope: 'global' },
      snapClassName: 'Bard',
      snapItemLevel: 1700,
    },
    {
      name: 'Dpschar',
      blackEntry: { name: 'Dpschar', reason: 'bad', scope: 'global' },
      snapClassName: 'Berserker',
      snapItemLevel: 1700,
    },
  ]);

  assert.match(lines[0], /Dpschar/);
  assert.match(lines[1], /Supportchar/);
});

test('formatCheckResults renders roster-match branch context', () => {
  const lines = formatCheckResults([
    {
      name: 'Altchar',
      blackEntry: { name: 'Mainchar', reason: 'RMT', raid: 'Act 4 Hard', scope: 'server' },
      snapClassName: 'Berserker',
      snapItemLevel: 1720,
      snapCombatScore: '90000',
    },
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⛔/u);
  assert.match(lines[0], /\(Local\)/);
  assert.match(lines[0], /via \*\*Mainchar\*\*/);
  assert.match(lines[0], /CP `90000`/);
});
