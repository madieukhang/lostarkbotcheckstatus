/**
 * listHandlers.js
 *
 * Thin orchestrator for the /list * command family. Each command family
 * lives in its own factory module under ./list/; this file only wires
 * shared services into each factory and exposes the unified handler
 * object that bot.js plugs into the interaction router.
 *
 * Module map:
 *   ./list/helpers.js     - pure module-level helpers (no closure on client)
 *   ./list/services.js    - shared closure services (broadcast, approval, persistence, bulk)
 *   ./list/add.js         - /list add + 3 button handlers (approval/viewevidence/overwrite)
 *   ./list/edit.js        - /list edit
 *   ./list/remove.js      - /list remove
 *   ./list/view.js        - /list view (paginated browse)
 *   ./list/check.js       - /listcheck (OCR screenshot)
 *   ./list/trust.js       - /list trust
 *   ./list/quickadd.js    - quick-add select + modal (used by /listcheck flow)
 *   ./list/multiadd.js    - /list multiadd + 2 button handlers (confirm/approval)
 */

import { createSharedServices } from './list/services.js';
import { createAddHandlers } from './list/add.js';
import { createCheckHandlers } from './list/check.js';
import { createEditHandlers } from './list/edit.js';
import { createEnrichHandlers } from './list/enrich.js';
import { createMultiaddHandlers } from './list/multiadd.js';
import { createQuickAddHandlers } from './list/quickadd.js';
import { createRemoveHandlers } from './list/remove.js';
import { createTrustHandlers } from './list/trust.js';
import { createViewHandlers } from './list/view.js';

export function createListHandlers({ client }) {
  const services = createSharedServices({ client });

  const add = createAddHandlers({ client, services });
  const check = createCheckHandlers({ client });
  const edit = createEditHandlers({ client, services });
  const enrich = createEnrichHandlers({ client, services });
  const multiadd = createMultiaddHandlers({ client, services });
  const quickadd = createQuickAddHandlers({ client, services });
  const remove = createRemoveHandlers({ client, services });
  const trust = createTrustHandlers({ client });
  const view = createViewHandlers({ client });

  return {
    handleListCheckCommand: check.handleListCheckCommand,
    handleListAddCommand: add.handleListAddCommand,
    handleListEditCommand: edit.handleListEditCommand,
    handleListEnrichCommand: enrich.handleListEnrichCommand,
    handleListRemoveCommand: remove.handleListRemoveCommand,
    handleListViewCommand: view.handleListViewCommand,
    handleListTrustCommand: trust.handleListTrustCommand,
    handleListMultiaddCommand: multiadd.handleListMultiaddCommand,
    handleMultiaddConfirmButton: multiadd.handleMultiaddConfirmButton,
    handleMultiaddApprovalButton: multiadd.handleMultiaddApprovalButton,
    handleListAddApprovalButton: add.handleListAddApprovalButton,
    handleListAddViewEvidenceButton: add.handleListAddViewEvidenceButton,
    handleListAddOverwriteButton: add.handleListAddOverwriteButton,
    handleListEnrichConfirmButton: enrich.handleListEnrichConfirmButton,
    handleListEnrichCancelButton: enrich.handleListEnrichCancelButton,
    handleQuickAddSelect: quickadd.handleQuickAddSelect,
    handleQuickAddModal: quickadd.handleQuickAddModal,
  };
}
