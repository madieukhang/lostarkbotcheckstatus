/**
 * handlers/list/form/fields.js
 * The /la-list add-form and edit-form modals, and the reading of their
 * submits into the same requests /la-list add and edit build from options.
 */

import {
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { getSelectableRaidValues } from '../../../models/Raid.js';
import { LIST_REASON_MAX_LENGTH } from '../../../models/listEntrySchema.js';
import { t } from '../../../services/i18n/index.js';
import { buildListAddRequest } from '../add/command.js';
import { buildListEditInput } from '../edit/command.js';

export const LIST_FORM_IDS = Object.freeze({
  addModal: 'listform_add',
  // The add form opened from Quick-Add on a /la-check card; it answers privately.
  quickAddModal: 'listform_quickadd',
  editModal: 'listform_edit',
  type: 'listform_type',
  name: 'listform_name',
  reason: 'listform_reason',
  raid: 'listform_raid',
  image: 'listform_image',
});

// The list dropdown: a value carries the blacklist scope after a colon, since
// scope only applies to blacklist. Plain `black` leaves the scope to the
// handler (the server default on add, the entry's own scope on edit).
const TYPE_CHOICES = Object.freeze([
  { value: 'black', key: 'black' },
  { value: 'black:server', key: 'blackServer' },
  { value: 'black:global', key: 'blackGlobal' },
  { value: 'white', key: 'white' },
  { value: 'watch', key: 'watch' },
]);

// Discord's limit on the options of one select.
const SELECT_OPTION_LIMIT = 25;

const label = (lang, key) => new LabelBuilder().setLabel(t(`listForm.${key}`, lang));

function choiceSelect(id, { required, placeholder, options }) {
  return new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setRequired(required)
    .setMinValues(required ? 1 : 0)
    .setMaxValues(1)
    .addOptions(options);
}

function typeSelect(lang, { required, placeholderKey, blackHintKey, chosen = '' }) {
  return choiceSelect(LIST_FORM_IDS.type, {
    required,
    placeholder: t(`listForm.${placeholderKey}`, lang),
    options: TYPE_CHOICES.map(({ value, key }) => ({
      label: t(`listForm.types.${key}`, lang),
      value,
      ...(value === 'black' ? { description: t(`listForm.types.${blackHintKey}`, lang) } : {}),
      ...(value === chosen ? { default: true } : {}),
    })),
  });
}

function raidSelect(lang, { placeholderKey, required }, now) {
  return choiceSelect(LIST_FORM_IDS.raid, {
    required,
    placeholder: t(`listForm.${placeholderKey}`, lang),
    options: getSelectableRaidValues({ now })
      .slice(0, SELECT_OPTION_LIMIT)
      .map((raid) => ({ label: raid, value: raid })),
  });
}

function textInput(id, { style, required, placeholder, value = '', maxLength = 0 }) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(style)
    .setRequired(required)
    .setPlaceholder(placeholder);
  if (maxLength) input.setMaxLength(maxLength);
  return value ? input.setValue(value) : input;
}

// A file upload asks for one file unless min_values says otherwise.
const imageUpload = () => new FileUploadBuilder()
  .setCustomId(LIST_FORM_IDS.image)
  .setRequired(false)
  .setMinValues(0)
  .setMaxValues(1);

/**
 * The add form: list (with blacklist scope), name, reason, raid and an
 * optional evidence screenshot. /la-list add-form opens it empty; Quick-Add
 * opens it with the picked name and blacklist chosen.
 * @param {string} lang - viewer language
 * @param {object} [options]
 * @param {Date} [options.now] - clock for the selectable raids
 * @param {string} [options.customId] - LIST_FORM_IDS.addModal or quickAddModal
 * @param {string} [options.name] - name to fill in
 * @param {string} [options.chosenType] - list dropdown value to preselect
 * @returns {ModalBuilder}
 */
export function buildListAddFormModal(lang, {
  now = new Date(),
  customId = LIST_FORM_IDS.addModal,
  name = '',
  chosenType = '',
} = {}) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(t('listForm.addTitle', lang))
    .addLabelComponents(
      label(lang, 'typeLabel').setStringSelectMenuComponent(typeSelect(lang, {
        required: true, placeholderKey: 'typePlaceholder', blackHintKey: 'blackAddHint', chosen: chosenType,
      })),
      label(lang, 'nameLabel').setTextInputComponent(textInput(LIST_FORM_IDS.name, {
        style: TextInputStyle.Short, required: true, placeholder: t('listForm.namePlaceholder', lang), value: name,
      })),
      label(lang, 'reasonLabel').setTextInputComponent(textInput(LIST_FORM_IDS.reason, {
        style: TextInputStyle.Paragraph, required: true, placeholder: t('listForm.reasonPlaceholder', lang), maxLength: LIST_REASON_MAX_LENGTH,
      })),
      label(lang, 'raidLabel').setStringSelectMenuComponent(raidSelect(lang, { placeholderKey: 'raidPlaceholder', required: true }, now)),
      label(lang, 'imageLabel').setFileUploadComponent(imageUpload()),
    );
}

/**
 * The /la-list edit-form modal: the name of the entry, then optional
 * changes; a field left empty keeps the entry's value.
 * @param {string} lang - viewer language
 * @param {object} [options]
 * @param {Date} [options.now] - clock for the selectable raids
 * @param {string} [options.name] - name searched in the command, filled in
 * @returns {ModalBuilder}
 */
export function buildListEditFormModal(lang, { now = new Date(), name = '' } = {}) {
  return new ModalBuilder()
    .setCustomId(LIST_FORM_IDS.editModal)
    .setTitle(t('listForm.editTitle', lang))
    .addLabelComponents(
      label(lang, 'nameLabel').setTextInputComponent(textInput(LIST_FORM_IDS.name, {
        style: TextInputStyle.Short, required: true, placeholder: t('listForm.namePlaceholder', lang), value: name,
      })),
      label(lang, 'newReasonLabel').setTextInputComponent(textInput(LIST_FORM_IDS.reason, {
        style: TextInputStyle.Paragraph, required: false, placeholder: t('listForm.newReasonPlaceholder', lang), maxLength: LIST_REASON_MAX_LENGTH,
      })),
      label(lang, 'newTypeLabel').setStringSelectMenuComponent(
        typeSelect(lang, { required: false, placeholderKey: 'newTypePlaceholder', blackHintKey: 'blackEditHint' }),
      ),
      label(lang, 'newRaidLabel').setStringSelectMenuComponent(raidSelect(lang, { placeholderKey: 'newRaidPlaceholder', required: false }, now)),
      label(lang, 'newImageLabel').setFileUploadComponent(imageUpload()),
    );
}

/**
 * Splits a list dropdown value into the list and the blacklist scope.
 * @param {string} [value] - one of the dropdown values, or '' when unchosen
 * @returns {{type: string, scope: string}} '' for a part not given
 */
export function parseListFormType(value = '') {
  const [type = '', scope = ''] = String(value).split(':');
  return { type, scope };
}

// A field the submit does not carry reads as empty.
const submittedText = (fields, id) => (fields.fields.has(id) ? fields.getTextInputValue(id) ?? '' : '');
const submittedChoice = (fields, id) => (fields.fields.has(id) ? fields.getStringSelectValues(id)?.[0] ?? '' : '');
const submittedFile = (fields, id) => (fields.fields.has(id) ? fields.getUploadedFiles(id)?.first() ?? null : null);

/**
 * Reads an add-form submit into the request /la-list add builds.
 * @param {import('discord.js').ModalSubmitFields} fields
 * @returns {object} from buildListAddRequest
 */
export function readListAddForm(fields) {
  const { type, scope } = parseListFormType(submittedChoice(fields, LIST_FORM_IDS.type));
  return buildListAddRequest({
    type,
    name: submittedText(fields, LIST_FORM_IDS.name),
    reason: submittedText(fields, LIST_FORM_IDS.reason),
    raidInput: submittedChoice(fields, LIST_FORM_IDS.raid),
    image: submittedFile(fields, LIST_FORM_IDS.image),
    inputScope: scope,
  });
}

/**
 * Reads an edit-form submit into the input /la-list edit builds.
 * @param {import('discord.js').ModalSubmitFields} fields
 * @returns {object} from buildListEditInput
 */
export function readListEditForm(fields) {
  const { type, scope } = parseListFormType(submittedChoice(fields, LIST_FORM_IDS.type));
  return buildListEditInput({
    name: submittedText(fields, LIST_FORM_IDS.name),
    reason: submittedText(fields, LIST_FORM_IDS.reason),
    type,
    raidInput: submittedChoice(fields, LIST_FORM_IDS.raid),
    image: submittedFile(fields, LIST_FORM_IDS.image),
    scope,
  });
}
