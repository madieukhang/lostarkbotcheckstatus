/**
 * ui.js
 *
 * Cross-handler UI tokens + small helpers. Centralises color hex codes,
 * status icons, and Discord-native timestamp helpers so every embed
 * builder pulls from the same source instead of inlining values.
 *
 * Ported from sister bot RaidManage's `src/raid/shared.js` so embed
 * styling reads consistent across the two bots. Domain-specific tokens
 * (e.g. blacklist/whitelist/watchlist icons) live with their handler
 * (`bot/handlers/list/helpers.js#getListContext`); this module only
 * carries cross-cutting concerns.
 */

/**
 * Severity colors. The `success`/`warning`/`info`/`danger`/`muted` set
 * matches Discord's brand palette so the embeds feel native; `trusted`
 * is a distinct shade used for the trusted-user block card.
 */
export const COLORS = Object.freeze({
  success:     0x57f287,   // Discord green     - operation completed
  warning:     0xfee75c,   // Discord yellow    - blocked but recoverable
  info:        0x5865f2,   // Discord blurple   - neutral info / picker UI
  danger:      0xed4245,   // Discord red       - error / blacklist
  muted:       0x99aab5,   // Discord grey      - expired / cancelled session
  trusted:     0x3b82f6,   // Tailwind blue     - trusted-user block card
  trustedSoft: 0x57d6a1,   // Soft teal-green   - trusted list view (informational, not alarming)
  gold:        0xf1c40f,   // Owner-special     - /la-remote view header for owner guild
  greyDark:    0x95a5a6,   // Inactive          - guilds with no config in /la-remote view
});

/**
 * Icon vocabulary. Three buckets:
 *   - severity : single-glyph indicators paired with COLORS above.
 *   - status   : multi-state stoplights for "where is this entity?"
 *                (e.g. enrich-preview rows; matches RaidManage's gate
 *                icons so users moving between bots see the same
 *                visual language).
 *   - action   : verb glyphs used in titles/buttons.
 *   - persona  : fox icon for Artist signature moments (use sparingly
 *                per memory `feedback_bot_persona.md`).
 */
export const ICONS = Object.freeze({
  // severity
  done: '✅',
  warn: '⚠️',
  error: '❌',
  info: 'ℹ️',
  shield: '🛡️',
  // status (RaidManage parity)
  ready: '🟢',
  partial: '🟡',
  pending: '⚪',
  locked: '🔒',
  // action
  search: '🔍',
  link: '🔗',
  evidence: '📎',
  refresh: '🔄',
  bulk: '📦',
  dm: '📩',
  edit: '✏️',
  add: '➕',
  remove: '➖',
  prev: '◀',
  next: '▶',
  // persona signature (use sparingly)
  fox: '🦊',
});

/**
 * Discord native relative timestamp (`<t:UNIX:R>`). Renders client-side
 * and ticks live without a message edit, so a "5 minutes ago" footer
 * stays accurate over the embed's lifetime. Returns `''` for falsy or
 * unparseable input so callers can blindly concatenate.
 *
 * @param {Date|number|string} when
 * @returns {string}
 */
export function relativeTime(when) {
  if (!when) return '';
  const ts = typeof when === 'number' ? when : new Date(when).getTime();
  if (Number.isNaN(ts)) return '';
  return `<t:${Math.floor(ts / 1000)}:R>`;
}

/**
 * Discord native short-form absolute timestamp (`<t:UNIX:f>`). Renders
 * in the viewer's locale + timezone. Same robustness as relativeTime.
 *
 * @param {Date|number|string} when
 * @returns {string}
 */
export function absoluteTime(when) {
  if (!when) return '';
  const ts = typeof when === 'number' ? when : new Date(when).getTime();
  if (Number.isNaN(ts)) return '';
  return `<t:${Math.floor(ts / 1000)}:f>`;
}

/**
 * Build the canonical "Session Nm · only-you" footer line used by
 * ephemeral-with-buttons confirm dialogs (enrich, edit picker, etc.).
 * Centralised so the cap reads identical across handlers.
 *
 * Voice is English to match the rest of LoaLogs' user-facing copy;
 * sister bot RaidManage is VN-first and uses its own copy of this
 * helper rather than this one.
 *
 * @param {number} minutes - TTL of the session in minutes.
 * @param {string} [ownerNote='only you can act']
 * @returns {string}
 */
export function buildSessionFooter(minutes, ownerNote = 'only you can act') {
  return `Session ${minutes}m · ${ownerNote}`;
}

/**
 * Stack multiple cooldown/freshness lines onto separate rows for the
 * "two-line freshness" pattern used in RaidManage's raid-status view.
 * Drops empty/falsy entries so callers can pass conditional values.
 *
 * @param  {...string} lines
 * @returns {string}
 */
export function buildCooldownLines(...lines) {
  return lines.filter(Boolean).join('\n');
}
