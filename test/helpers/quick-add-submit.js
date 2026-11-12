import assert from 'node:assert/strict';

import { createListAddCommandHandler } from '../../bot/handlers/list/add/command.js';
import { LIST_FORM_IDS } from '../../bot/handlers/list/form/fields.js';
import { createListFormHandlers } from '../../bot/handlers/list/form/index.js';
import { modalSubmitFields } from './modal-submit.js';

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
 * The fields of a submitted Quick-Add form, raid and screenshot left out.
 * @param {{type: string, name: string, reason: string}} values
 * @returns {import('discord.js').ModalSubmitFields}
 */
export function quickAddFields({ type, name, reason }) {
  return modalSubmitFields({
    texts: { [LIST_FORM_IDS.name]: name, [LIST_FORM_IDS.reason]: reason },
    selects: { [LIST_FORM_IDS.type]: [type] },
  });
}
