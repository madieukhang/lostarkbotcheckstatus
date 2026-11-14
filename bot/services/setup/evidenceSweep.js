/**
 * services/setup/evidenceSweep.js
 * Runs the evidence sweep at boot and every six hours: images members'
 * requests archived before any approval are kept once an entry or request
 * points at them, and removed when nothing has for two days.
 */

import { createCleanupScheduler } from './cleanupRuntime.js';
import { sweepPendingEvidenceImages } from '../../utils/evidenceStore.js';

const EVIDENCE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const scheduler = createCleanupScheduler({
  runCleanup: async (client) => {
    const { confirmed, removed } = await sweepPendingEvidenceImages({ client });
    if (confirmed || removed) console.log(`[evidence sweep] kept ${confirmed}, removed ${removed}`);
  },
  intervalMs: EVIDENCE_SWEEP_INTERVAL_MS,
  failureLabel: '[evidence sweep] unexpected scheduler failure:',
});

/**
 * Start the evidence sweep once per process.
 * @param {import('discord.js').Client} client - the bot client
 * @returns {NodeJS.Timeout} the interval timer
 */
export function startEvidenceSweep(client) {
  return scheduler.start(client);
}
