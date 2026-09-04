import { createApprovalServices } from './approvals.js';
import { createListAddExecutor } from './addExecutor.js';
import { createBroadcastServices } from './broadcasts.js';
import { createBulkServices } from './bulk.js';

/**
 * Share approval/broadcast services and the same guarded add executor across
 * single-add and bulk flows, so their persistence rules cannot diverge here.
 * @param {{client: import('discord.js').Client}} deps
 * @returns {Object<string, Function>} Services shared by the list handlers.
 */
export function createSharedServices({ client }) {
  const approvals = createApprovalServices({ client });
  const broadcasts = createBroadcastServices({ client });
  const executeListAddToDatabase = createListAddExecutor({
    client,
    broadcastListChange: broadcasts.broadcastListChange,
  });

  return {
    ...approvals,
    ...broadcasts,
    executeListAddToDatabase,
    ...createBulkServices({ client, executeListAddToDatabase }),
  };
}
