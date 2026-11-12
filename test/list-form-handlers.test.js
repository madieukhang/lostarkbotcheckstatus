import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache, t as translate } from '../bot/services/i18n/index.js';
import { buildCommands } from '../bot/commands/index.js';
import { createCommandRoutes, createModalRoutes, findCustomIdRoute } from '../bot/app/interaction-router.js';
import { LIST_FORM_IDS } from '../bot/handlers/list/form/fields.js';
import { createListFormHandlers } from '../bot/handlers/list/form/index.js';

function stubEnglishViewer(t) {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function commandInteraction({ guild = { id: 'form-guild' } } = {}) {
  const seen = { modals: [], replies: [] };
  return {
    seen,
    user: { id: 'viewer' },
    guild,
    showModal: async (modal) => { seen.modals.push(modal.toJSON()); },
    reply: async (payload) => { seen.replies.push(payload); },
  };
}

// Records what each form submit hands to the add and edit handlers.
function recordingForms() {
  const calls = [];
  const handlers = createListFormHandlers({
    handleListAddCommand: async (...args) => { calls.push(['add', ...args]); },
    handleListEditCommand: async (...args) => { calls.push(['edit', ...args]); },
  });
  return { calls, handlers };
}

// A submit carrying only a name and a reason.
const nameOnlySubmit = (customId) => {
  const values = { [LIST_FORM_IDS.name]: 'mokoko', [LIST_FORM_IDS.reason]: 'Report' };
  return {
    customId,
    fields: {
      fields: new Map(Object.keys(values).map((id) => [id, {}])),
      getTextInputValue: (id) => values[id],
    },
  };
};

for (const [command, modalId] of [['handleListAddFormCommand', LIST_FORM_IDS.addModal], ['handleListEditFormCommand', LIST_FORM_IDS.editModal]]) {
  test(`${command} opens its form in a server`, async (t) => {
    stubEnglishViewer(t);
    const interaction = commandInteraction();
    await recordingForms().handlers[command](interaction);
    assert.deepEqual(interaction.seen.modals.map((modal) => modal.custom_id), [modalId]);
    assert.equal(interaction.seen.replies.length, 0);
  });

  test(`${command} outside a server says so and opens no form`, async (t) => {
    stubEnglishViewer(t);
    const interaction = commandInteraction({ guild: null });
    await recordingForms().handlers[command](interaction);
    assert.equal(interaction.seen.modals.length, 0);
    assert.ok(interaction.seen.replies[0].embeds[0].toJSON().title.includes(translate('dialogue.common.serverOnly', 'en').title));
  });
}

test('each form submit hands the request it read to the add or edit handler', async () => {
  const { calls, handlers } = recordingForms();
  const add = nameOnlySubmit(LIST_FORM_IDS.addModal);
  const quick = nameOnlySubmit(LIST_FORM_IDS.quickAddModal);
  const edit = nameOnlySubmit(LIST_FORM_IDS.editModal);

  await handlers.handleListAddFormSubmit(add);
  await handlers.handleQuickAddFormSubmit(quick);
  await handlers.handleListEditFormSubmit(edit);

  assert.deepEqual(calls.map(([kind, interaction, request, options]) => [kind, interaction, request.name, request.reason ?? request.newReason, options]), [
    ['add', add, 'Mokoko', 'Report', undefined],
    ['add', quick, 'Mokoko', 'Report', { ephemeral: true }],
    ['edit', edit, 'Mokoko', 'Report', undefined],
  ]);
});

test('/la-list routes add-form and edit-form, and each form id reaches its submit', () => {
  const listHandlers = Object.fromEntries([
    'handleListAddFormCommand', 'handleListEditFormCommand',
    'handleListAddFormSubmit', 'handleListEditFormSubmit', 'handleQuickAddFormSubmit',
  ].map((name) => [name, async () => name]));
  const { subcommands } = createCommandRoutes({ systemHandlers: {}, listHandlers })['la-list'];
  assert.equal(subcommands['add-form'], listHandlers.handleListAddFormCommand);
  assert.equal(subcommands['edit-form'], listHandlers.handleListEditFormCommand);

  const modalRoutes = createModalRoutes(listHandlers);
  const routed = (id) => findCustomIdRoute(modalRoutes, id)?.handle;
  assert.ok(routed(LIST_FORM_IDS.addModal));
  assert.ok(routed(LIST_FORM_IDS.editModal));
  assert.ok(routed(LIST_FORM_IDS.quickAddModal));
  assert.equal(routed('quickadd_modal:Mokoko'), undefined, 'the old Quick-Add modal is gone');
});

test('the form subcommands ask nothing but an optional name to search in edit-form', () => {
  const list = buildCommands().find((command) => command.name === 'la-list');
  const expected = { 'add-form': [], 'edit-form': [['name', false]] };
  for (const [name, options] of Object.entries(expected)) {
    const sub = list.options.find((option) => option.name === name);
    assert.ok(sub, name);
    assert.ok(sub.description.length > 0 && sub.description.length <= 100);
    assert.deepEqual((sub.options ?? []).map((option) => [option.name, Boolean(option.required)]), options, name);
  }
});
