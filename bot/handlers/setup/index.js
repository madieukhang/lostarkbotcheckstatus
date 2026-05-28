/**
 * handlers/setup/index.js
 * Aggregate re-export surface for the /la-setup family. guildSetup
 * owns the per-guild config flow (auto-check channel, notify channel,
 * scope, global-notify); remote owns the owner-only commands for
 * pinning + remote settings management.
 */

export { handleSetupCommand } from './guildSetup.js';
export { handleSetupRemoteCommand } from './remote.js';
