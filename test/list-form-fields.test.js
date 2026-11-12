import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

import { getSelectableRaidValues } from '../bot/models/Raid.js';
import { buildListAddRequest } from '../bot/handlers/list/add/command.js';
import { buildListEditInput } from '../bot/handlers/list/edit/command.js';
import {
  LIST_FORM_IDS,
  buildListAddFormModal,
  buildListEditFormModal,
  parseListFormType,
  readListAddForm,
  readListEditForm,
} from '../bot/handlers/list/form/fields.js';

const SELECT = 3;
const TEXT = 4;
const FILE = 19;
const LABEL = 18;
const TYPE_VALUES = ['black', 'black:server', 'black:global', 'white', 'watch'];
const ID = LIST_FORM_IDS;

// The rows of a built modal as [component type, custom id, required].
const rowsOf = (modal) => modal.toJSON().components.map((row) => {
  assert.equal(row.type, LABEL);
  return [row.component.type, row.component.custom_id, row.component.required];
});
const optionValues = (modal, id) => modal.toJSON().components
  .find((row) => row.component.custom_id === id).component.options.map((option) => option.value);

// Stands in for ModalSubmitFields: only the ids in `values` were submitted.
function submitted(values) {
  const present = new Map(Object.keys(values).map((id) => [id, {}]));
  return {
    fields: present,
    getTextInputValue: (id) => values[id],
    getStringSelectValues: (id) => values[id],
    getUploadedFiles: (id) => values[id],
  };
}

test('the add form asks for list, name, reason, raid and an optional screenshot', () => {
  const modal = buildListAddFormModal('en');
  assert.equal(modal.toJSON().custom_id, ID.addModal);
  assert.deepEqual(rowsOf(modal), [
    [SELECT, ID.type, true],
    [TEXT, ID.name, true],
    [TEXT, ID.reason, true],
    [SELECT, ID.raid, false],
    [FILE, ID.image, false],
  ]);
  assert.deepEqual(optionValues(modal, ID.type), TYPE_VALUES);
  assert.deepEqual(optionValues(modal, ID.raid), getSelectableRaidValues());
});

test('the edit form asks for the name and leaves every change optional', () => {
  const modal = buildListEditFormModal('en');
  assert.equal(modal.toJSON().custom_id, ID.editModal);
  assert.deepEqual(rowsOf(modal), [
    [TEXT, ID.name, true],
    [TEXT, ID.reason, false],
    [SELECT, ID.type, false],
    [SELECT, ID.raid, false],
    [FILE, ID.image, false],
  ]);
  assert.deepEqual(optionValues(modal, ID.type), TYPE_VALUES);
});

test('the plain blacklist choice says what happens to the scope in each form', () => {
  const blackHint = (modal) => modal.toJSON().components
    .find((row) => row.component.custom_id === ID.type).component.options[0].description;
  assert.ok(blackHint(buildListAddFormModal('en')));
  assert.notEqual(blackHint(buildListAddFormModal('en')), blackHint(buildListEditFormModal('en')));
});

test('both forms fit Discord text limits in every language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    for (const modal of [buildListAddFormModal(lang), buildListEditFormModal(lang)]) {
      const json = modal.toJSON();
      assert.ok(json.title.length <= 45, `${lang} title`);
      for (const row of json.components) {
        assert.ok(row.label.length <= 45, `${lang} ${row.label}`);
        for (const option of row.component.options || []) {
          assert.ok(option.label.length <= 100 && (option.description ?? '').length <= 100, `${lang} ${option.label}`);
        }
      }
    }
  }
});

test('the type choice carries the blacklist scope', () => {
  assert.deepEqual(parseListFormType('black'), { type: 'black', scope: '' });
  assert.deepEqual(parseListFormType('black:server'), { type: 'black', scope: 'server' });
  assert.deepEqual(parseListFormType('black:global'), { type: 'black', scope: 'global' });
  assert.deepEqual(parseListFormType('watch'), { type: 'watch', scope: '' });
  assert.deepEqual(parseListFormType(''), { type: '', scope: '' });
});

test('an add form submit becomes the request the add command builds', () => {
  const proof = { url: 'https://cdn.example.test/proof.png', contentType: 'image/png' };
  const request = readListAddForm(submitted({
    [ID.type]: ['black:server'],
    [ID.name]: 'mokoko',
    [ID.reason]: 'Left mid-raid',
    [ID.raid]: ['Serca Hard'],
    [ID.image]: new Collection([['1', proof]]),
  }));

  assert.deepEqual(request, buildListAddRequest({
    type: 'black', name: 'mokoko', reason: 'Left mid-raid', raidInput: 'Serca Hard', image: proof, inputScope: 'server',
  }));
});

test('an edit form with only a name reads every change as keep, even with fields left out', () => {
  const input = readListEditForm(submitted({ [ID.name]: 'mokoko', [ID.type]: [], [ID.image]: null }));
  assert.deepEqual(input, buildListEditInput({ name: 'mokoko' }));
});

test('an edit form moving an entry to a server-only blacklist reads type and scope', () => {
  const input = readListEditForm(submitted({ [ID.name]: 'mokoko', [ID.type]: ['black:server'], [ID.raid]: ['Serca NM'] }));
  assert.equal(input.newType, 'black');
  assert.equal(input.newScope, 'server');
  assert.equal(input.newRaidInput, 'Serca NM');
});
