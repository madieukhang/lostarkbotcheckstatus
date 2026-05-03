import { createListEditCommandHandler } from './command.js';

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
