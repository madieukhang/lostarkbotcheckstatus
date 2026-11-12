import { createSharedServices } from './services/index.js';
import { createAddHandlers } from './add/index.js';
import { createCheckHandlers } from './check/index.js';
import { createEditHandlers } from './edit/index.js';
import { createEnrichHandlers } from './enrich/index.js';
import { createListFormHandlers } from './form/index.js';
import {
  createEvidenceHandlers,
  handleListEvidenceAutocomplete,
} from './evidence/command.js';
import { createBroadcastEvidenceButtonHandler } from './evidence/broadcastButton.js';
import { createEntryEvidenceButtonHandler } from './evidence/entryButton.js';
import { createMultiaddHandlers } from './multiadd/index.js';
import { createNoteHandlers } from './notes/index.js';
import { createQuickAddHandlers } from './quickadd/index.js';
import { createRemoveHandlers } from './remove/index.js';
import { createTrustHandlers } from './trust/index.js';
import { createViewHandlers } from './view/index.js';

export { handleListEvidenceAutocomplete };

/**
 * Compose the list command families with one shared set of approval/write services.
 * Each family owns its named handlers; the router consumes their combined surface.
 * @param {{client: import('discord.js').Client}} deps
 * @returns {Object<string, Function>} Slash-command and component handlers.
 */
export function createListHandlers({ client }) {
  const services = createSharedServices({ client });
  const addHandlers = createAddHandlers({ client, services });
  const editHandlers = createEditHandlers({ client, services });

  return {
    ...addHandlers,
    ...createCheckHandlers({ client }),
    ...editHandlers,
    ...createEnrichHandlers({ services }),
    ...createEvidenceHandlers({ client }),
    ...createListFormHandlers({
      handleListAddCommand: addHandlers.handleListAddCommand,
      handleListEditCommand: editHandlers.handleListEditCommand,
    }),
    handleBroadcastEvidenceButton: createBroadcastEvidenceButtonHandler({ client }),
    handleEntryEvidenceButton: createEntryEvidenceButtonHandler({ client }),
    ...createMultiaddHandlers({ client, services }),
    ...createNoteHandlers({ services }),
    ...createQuickAddHandlers(),
    ...createRemoveHandlers({ services }),
    ...createTrustHandlers({ client }),
    ...createViewHandlers({ client }),
  };
}
