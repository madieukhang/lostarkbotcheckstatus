import test from 'node:test';
import assert from 'node:assert/strict';
import { getCooldownWaitSeconds, markCooldown } from '../bot/handlers/list/enrich/state.js';

test('enrich keeps its 30-second cooldown for equivalent character names', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  markCooldown('  Zoë  ');
  assert.equal(getCooldownWaitSeconds('ZOE\u0308'), 30);
  t.mock.timers.tick(29_500);
  assert.equal(getCooldownWaitSeconds('zoë'), 1);
  t.mock.timers.tick(500);
  assert.equal(getCooldownWaitSeconds('zoë'), 0);
});
