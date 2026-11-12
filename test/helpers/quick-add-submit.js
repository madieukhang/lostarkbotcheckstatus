import assert from 'node:assert/strict';

import { createListAddCommandHandler } from '../../bot/handlers/list/add/command.js';
import { LIST_FORM_IDS } from '../../bot/handlers/list/form/fields.js';
import { createListFormHandlers } from '../../bot/handlers/list/form/index.js';

/**
 * Quick-Add's submit as the bot wires it: the add form, run by the
 * /la-list add handler with the given approval services.
 * @param {{sendListAddApprovalToApprovers: Function, executeListAddToDatabase: Function}} services
 * @returns {Function} (interaction) => Promise
 */
export function quickAddSubmit(services) {
  return createListFormHandlers({
    handleListAddCommand: createListAddCommandHandler({ client: {}, ...services }),
    handleListEditCommand: () => assert.fail('Quick-Add never edits'),
  }).handleQuickAddFormSubmit;
}

/**
 * The fields of a submitted Quick-Add form.
 * @param {{type: string, name: string, reason: string}} values
 * @returns {object} stands in for ModalSubmitFields
 */
export function quickAddFields({ type, name, reason }) {
  const values = { [LIST_FORM_IDS.type]: [type], [LIST_FORM_IDS.name]: name, [LIST_FORM_IDS.reason]: reason };
  return {
    fields: new Map(Object.keys(values).map((id) => [id, {}])),
    getTextInputValue: (id) => values[id],
    getStringSelectValues: (id) => values[id],
    getUploadedFiles: () => null,
  };
}
