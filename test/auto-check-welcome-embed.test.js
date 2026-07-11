import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAutoCheckWelcomeEmbed } from '../bot/services/setup/autoCheckWelcome.js';

// The pin title doubles as an ownership signature (isOwnedWelcome matches it
// against titleSignatures). Asserting the exact string here is the guard that
// keeps repin/cleanup detection working after any copy rewrite.
const STABLE_TITLE = '🎨 Hi everyone~ Artist is keeping an eye on this channel';

test('welcome pin has the six-field structure incl. scope + quickAdd', () => {
  const json = buildAutoCheckWelcomeEmbed('en', { cleanupEnabled: true }).toJSON();
  assert.equal(json.title, STABLE_TITLE);
  assert.equal(json.fields.length, 6);
  const names = json.fields.map((f) => f.name).join('\n');
  assert.match(names, /Global vs server/i); // the new scope field
  assert.match(names, /Quick Add/i); // the new officer-tools field
});

test('cleanup off swaps in the off-variant field name', () => {
  const on = buildAutoCheckWelcomeEmbed('en', { cleanupEnabled: true }).toJSON();
  const off = buildAutoCheckWelcomeEmbed('en', { cleanupEnabled: false }).toJSON();
  assert.notEqual(on.fields[3].name, off.fields[3].name);
});
