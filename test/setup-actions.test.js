import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSetupActionChoices,
  isSetupActionVisible,
} from '../bot/handlers/setup/setupActions.js';

const t = (key) => key.split('.').pop(); // labelKey passthrough for tests
const base = { cleanupEnabled: false, notifyEnabled: true, autoChannelSet: true };

test('cleanup toggle visibility follows state and needs an auto-channel', () => {
  assert.equal(isSetupActionVisible({ value: 'cleanup-on' }, base), true);
  assert.equal(isSetupActionVisible({ value: 'cleanup-off' }, base), false);
  const enabled = { ...base, cleanupEnabled: true };
  assert.equal(isSetupActionVisible({ value: 'cleanup-on' }, enabled), false);
  assert.equal(isSetupActionVisible({ value: 'cleanup-off' }, enabled), true);
  const noChannel = { ...base, autoChannelSet: false };
  assert.equal(isSetupActionVisible({ value: 'cleanup-on' }, noChannel), false);
  assert.equal(isSetupActionVisible({ value: 'cleanup-off' }, noChannel), false);
});

test('notify toggle visibility follows the notify flag', () => {
  assert.equal(isSetupActionVisible({ value: 'notify-off' }, base), true);
  assert.equal(isSetupActionVisible({ value: 'notify-on' }, base), false);
  const off = { ...base, notifyEnabled: false };
  assert.equal(isSetupActionVisible({ value: 'notify-on' }, off), true);
  assert.equal(isSetupActionVisible({ value: 'notify-off' }, off), false);
});

test('buildSetupActionChoices filters by state and needle, always keeps non-toggle actions', () => {
  const all = buildSetupActionChoices({ needle: '', state: base, t, lang: 'en' });
  const values = all.map((c) => c.value);
  assert.ok(values.includes('show'));
  assert.ok(values.includes('cleanup-on'));
  assert.ok(!values.includes('cleanup-off')); // cleanup disabled -> off hidden
  assert.ok(!values.includes('notify-on')); // notify on -> on hidden

  const filtered = buildSetupActionChoices({ needle: 'chan', state: base, t, lang: 'en' });
  assert.ok(filtered.every((c) => /chan/i.test(c.name) || /chan/i.test(c.value)));
  assert.ok(filtered.some((c) => c.value === 'set-auto-channel'));
});

test('setup action builder respects a needle against localized names', () => {
  const labels = (key) => ({
    'dialogue.setup.actions.show': 'Show status',
    'dialogue.setup.actions.repin': 'Repin the guide',
  }[key] || key.split('.').pop());
  const choices = buildSetupActionChoices({ needle: 'status', state: base, t: labels, lang: 'en' });
  assert.deepEqual(choices.map((c) => c.value), ['show']);
});
