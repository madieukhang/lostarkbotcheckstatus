/**
 * deprecation.js
 *
 * Phase 4b banner helper. Every legacy slash command name
 * (`status`, `list`, `lahelp`, ...) gets a one-line followUp
 * note pointing the user at the new `la-` prefixed name.
 *
 * Hard cutover: 2026-05-17 (Phase 4c removes legacy aliases).
 */

const LEGACY_TO_MODERN = new Map([
  ['status', '/la-status'],
  ['reset', '/la-reset'],
  ['roster', '/la-roster'],
  ['search', '/la-search'],
  ['list', '/la-list'],
  ['listcheck', '/la-check'],
  ['lahelp', '/la-help'],
  ['lasetup', '/la-setup'],
  ['lastats', '/la-stats'],
  ['laremote', '/la-remote'],
]);

export const HARD_CUTOVER_DATE = '2026-05-17';

export function isLegacyCommandName(commandName) {
  return LEGACY_TO_MODERN.has(commandName);
}

/**
 * Build the deprecation banner string for a legacy command invocation.
 * Returns '' when the command is already on the modern surface.
 *
 * For `/list` we include the subcommand in the modern target so the
 * note is directly actionable (e.g. `/la-list add` vs just `/la-list`).
 */
export function getLegacyDeprecationBanner(interaction) {
  const modern = LEGACY_TO_MODERN.get(interaction.commandName);
  if (!modern) return '';
  let modernFull = modern;
  if (interaction.commandName === 'list') {
    try {
      const sub = interaction.options.getSubcommand(false);
      if (sub) modernFull = `${modern} ${sub}`;
    } catch {
      // No subcommand context (shouldn't happen for /list, but stay safe)
    }
  }
  return `📢 Heads up: \`/${interaction.commandName}\` is now \`${modernFull}\`. The legacy name stops working on ${HARD_CUTOVER_DATE}. Try \`${modernFull}\` next time.`;
}
