/**
 * services.js
 *
 * Shared closure services used by every /la-list * command handler. All
 * functions close over the Discord `client`, so they live in a factory
 * that takes `{ client }` and returns the service object.
 *
 * Service responsibilities:
 *   - Approval DM dispatch + sync (sendListAddApprovalToApprovers,
 *     sendBulkApprovalToApprovers, syncApproverDmMessages)
 *   - Database persistence with all guards (executeListAddToDatabase)
 *   - Cross-guild broadcast (broadcastListChange, resolveBroadcastChannels,
 *     broadcastBulkAdd)
 *   - Bulk multiadd execution + summary (executeBulkMultiadd,
 *     buildBulkSummaryEmbed)
 *   - Requester notification on approval/reject (notifyRequesterAboutDecision)
 */

import { createApprovalServices } from './approvals.js';
import { createListAddExecutor } from './addExecutor.js';
import { createBroadcastServices } from './broadcasts.js';
import { createBulkServices } from './bulk.js';

export function createSharedServices({ client }) {
  const {
    sendListAddApprovalToApprovers,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    notifyRequesterAboutDecision,
  } = createApprovalServices({ client });

  const {
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
  } = createBroadcastServices({ client });

  const executeListAddToDatabase = createListAddExecutor({
    client,
    broadcastListChange,
  });

  const {
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = createBulkServices({ client, executeListAddToDatabase });

  return {
    sendListAddApprovalToApprovers,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    executeListAddToDatabase,
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
    notifyRequesterAboutDecision,
  };
}
