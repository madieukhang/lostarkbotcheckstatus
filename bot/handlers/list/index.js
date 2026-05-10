/**
 * handlers/list/index.js
 *
 * Thin orchestrator for the /la-list * command family. Each command family
 * lives in its own factory folder next to this file; this module only wires
 * shared services into each factory and exposes the unified handler
 * object that bot.js plugs into the interaction router.
 *
 * Module map:
 *   ./helpers.js     - pure module-level helpers (no closure on client)
 *   ./services/      - shared closure services (approval, persistence, broadcast, bulk)
 *   ./add/           - /la-list add + 3 button handlers (approval/viewevidence/overwrite)
 *   ./edit/          - /la-list edit
 *   ./remove/        - /la-list remove
 *   ./view/          - /la-list view (paginated browse)
 *   ./check/         - /la-check (OCR screenshot)
 *   ./trust/         - /la-list trust
 *   ./quickadd/      - quick-add select + modal (used by /la-check flow)
 *   ./multiadd/      - /la-list multiadd + 2 button handlers (confirm/approval)
 */

import { createSharedServices } from './services/index.js';
import { createAddHandlers } from './add/index.js';
import { createCheckHandlers } from './check/index.js';
import { createEditHandlers } from './edit/index.js';
import { createEnrichHandlers } from './enrich/index.js';
import { createMultiaddHandlers } from './multiadd/index.js';
import { createQuickAddHandlers } from './quickadd/index.js';
import { createRemoveHandlers } from './remove/index.js';
import { createTrustHandlers } from './trust/index.js';
import { createViewHandlers } from './view/index.js';

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
    handleListEnrichContinueButton: enrich.handleListEnrichContinueButton,
    handleListAddEnrichHiddenButton: enrich.handleListAddEnrichHiddenButton,
    handleScanCancelButton: enrich.handleScanCancelButton,
    handleQuickAddSelect: quickadd.handleQuickAddSelect,
    handleQuickAddModal: quickadd.handleQuickAddModal,
  };
}
