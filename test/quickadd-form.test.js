import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { LIST_FORM_IDS } from '../bot/handlers/list/form/fields.js';
import { createQuickAddHandlers } from '../bot/handlers/list/quickadd/index.js';

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
