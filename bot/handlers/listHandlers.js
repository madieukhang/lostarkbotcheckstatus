/**
 * listHandlers.js
 *
 * Thin orchestrator for the /la-list * command family. Each command family
 * lives in its own factory folder under ./list/; this file only wires
 * shared services into each factory and exposes the unified handler
 * object that bot.js plugs into the interaction router.
 *
 * Module map:
 *   ./list/helpers.js     - pure module-level helpers (no closure on client)
 *   ./list/services/     - shared closure services (approval, persistence, broadcast, bulk)
 *   ./list/add/          - /la-list add + 3 button handlers (approval/viewevidence/overwrite)
 *   ./list/edit/         - /la-list edit
 *   ./list/remove/       - /la-list remove
 *   ./list/view/         - /la-list view (paginated browse)
 *   ./list/check/        - /la-check (OCR screenshot)
 *   ./list/trust/        - /la-list trust
 *   ./list/quickadd/     - quick-add select + modal (used by /la-check flow)
 *   ./list/multiadd/     - /la-list multiadd + 2 button handlers (confirm/approval)
 */

import { createSharedServices } from './list/services/index.js';
import { createAddHandlers } from './list/add/index.js';
import { createCheckHandlers } from './list/check/index.js';
import { createEditHandlers } from './list/edit/index.js';
import { createEnrichHandlers } from './list/enrich/index.js';
import { createMultiaddHandlers } from './list/multiadd/index.js';
import { createQuickAddHandlers } from './list/quickadd/index.js';
import { createRemoveHandlers } from './list/remove/index.js';
import { createTrustHandlers } from './list/trust/index.js';
import { createViewHandlers } from './list/view/index.js';

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
    handleListAddEnrichHiddenButton: enrich.handleListAddEnrichHiddenButton,
    handleQuickAddSelect: quickadd.handleQuickAddSelect,
    handleQuickAddModal: quickadd.handleQuickAddModal,
  };
}
