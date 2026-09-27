import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { CLASS_NAMES, CLASS_EMOJI_MAP } from '../bot/models/Class.js';

const ICONS_DIR = new URL('../assets/class-icons/', import.meta.url);

// The emoji bootstrap skips a PNG whose name is not a CLASS_NAMES key, so a
// new class icon without its entry never reaches Discord.
test('every class icon names a known bible class with a seeded emoji slot', () => {
  const ids = readdirSync(ICONS_DIR).filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -'.png'.length));
  assert.deepEqual(ids.filter((id) => !Object.hasOwn(CLASS_NAMES, id)), []);
  assert.deepEqual([...new Set(Object.values(CLASS_NAMES))].filter((name) => !Object.hasOwn(CLASS_EMOJI_MAP, name)), []);
});
