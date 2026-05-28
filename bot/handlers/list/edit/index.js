/**
 * handlers/list/edit/index.js
 * Compose root for the /la-list edit flow. Wires the slash-command
 * handler into a single bag. Edit reuses the same approval-flow
 * services as /la-list add (approver DM fan-out + broadcast).
 */

import { createListEditCommandHandler } from './command.js';

/**
 * Build the /la-list edit handler bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {object} deps.services - shared approval-flow services
 *   (sendListAddApprovalToApprovers, broadcastListChange)
 * @returns {{handleListEditCommand: Function}}
 */
export function createEditHandlers({ client, services }) {
  const { sendListAddApprovalToApprovers, broadcastListChange } = services;

  return {
    handleListEditCommand: createListEditCommandHandler({
      client,
      sendListAddApprovalToApprovers,
      broadcastListChange,
    }),
  };
}
