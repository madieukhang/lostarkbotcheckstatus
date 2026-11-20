import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { LIST_FORM_IDS } from '../bot/handlers/list/form/fields.js';
import { buildQuickAddRow, createQuickAddHandlers } from '../bot/handlers/list/quickadd/index.js';

test('quick add opens the add form with the picked name and blacklist chosen', async (t) => {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const shown = [];

  await createQuickAddHandlers().handleQuickAddSelect({
    values: ['Mokoko'],
    user: { id: 'officer' },
    showModal: async (modal) => { shown.push(modal.toJSON()); },
  });

  assert.equal(shown.length, 1);
  assert.equal(shown[0].custom_id, LIST_FORM_IDS.quickAddModal);
  const field = (id) => shown[0].components.find((row) => row.component.custom_id === id).component;
  assert.equal(field(LIST_FORM_IDS.name).value, 'Mokoko');
  assert.deepEqual(field(LIST_FORM_IDS.type).options.filter((option) => option.default).map((option) => option.value), ['black']);
  assert.ok(field(LIST_FORM_IDS.image), 'Quick-Add gets the screenshot field too');
});

test('the Quick Add menu ends with Select none, which clears the pick without a DB read', async (t) => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ name: `Name${index}` }));
  const row = buildQuickAddRow(candidates, 'vi').toJSON();
  const select = row.components[0];
  assert.equal(select.options.length, 25, 'Discord caps a menu at 25 options, Select none included');
  assert.equal(select.options.at(-1).value, 'none');
  assert.equal(select.options.at(-1).label, 'Bỏ chọn');
  assert.equal(buildQuickAddRow([], 'vi'), null);

  let connects = 0;
  t.mock.method(mongoose, 'connect', async () => { connects += 1; return mongoose; });
  const picked = { ...row, components: [{ ...select, options: select.options.map((option, index) => ({ ...option, default: index === 0 })) }] };
  const updates = [];
  let modals = 0;
  await createQuickAddHandlers().handleQuickAddSelect({
    values: ['none'],
    user: { id: 'officer' },
    message: { components: [picked] },
    update: async (payload) => { updates.push(payload); },
    showModal: async () => { modals += 1; },
  });

  assert.equal(modals, 0);
  assert.equal(connects, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].components[0].components[0].options.some((option) => option.default), false);
});

test('buildQuickAddRow deduplicates candidates that resolved to the same character name', () => {
  const row = buildQuickAddRow([
    { name: 'Lunaria' },
    { name: 'Lunaria' },
    { name: 'lunaria' },
    { name: 'Mokoko' },
  ], 'en').toJSON();
  const values = row.components[0].options.map((option) => option.value);
  assert.deepEqual(values, ['Lunaria', 'Mokoko', 'none']);
});
