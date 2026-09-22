/**
 * handlers/list/entryCardFields.js
 *
 * Field builders shared by the /la-list add and /la-list edit success
 * cards, so both keep the same icons, labels, order and row padding. The
 * edit card passes the values it replaced to mark them in place.
 *
 * Imports no list handler: services/addExecutor.js and helpers.js both use
 * this module, and addExecutor.js already imports helpers.js.
 */

import { t } from '../../services/i18n/index.js';
import { normalizeNameKey } from '../../utils/names.js';
import { padInlineRow } from '../../utils/ui.js';
import {
  formatRosterStatBadges,
  renderTrackedAltsField,
  resolveRosterWorld,
} from './trackedAltsRender.js';

const FIELD_VALUE_LIMIT = 1024;
const CHANGED_MARK = ' ✏️';
// The two ~~ pairs, the trailing … and 15 characters of the old reason.
// Less than that reads as noise, so the struck line is dropped instead.
const MIN_STRUCK_REASON_LENGTH = 20;

function scopeLabel(scope, lang) {
  return t(`dialogue.approval.scopeTag.${scope === 'server' ? 'local' : 'global'}`, lang);
}

/**
 * Render a replaced value as struck-through text. Whitespace collapses to
 * one line because a strike does not span lines. Tildes and backslashes are
 * escaped: a tilde could close the strike early, and a trailing backslash
 * would escape the closing marker.
 * @param {string} value - the value before the edit
 * @param {number} [maxLength=Infinity] - length cap for the whole token,
 *   markers included; longer text is cut and ends with …
 * @returns {string} the struck-through value
 */
export function formatStruckValue(value, maxLength = Infinity) {
  let text = String(value).replace(/\s+/gu, ' ').trim().replace(/[\\~]/gu, '\\$&');
  const room = maxLength - 4;
  if (text.length > room) {
    // A cut can end on the backslash of an escape, which would swallow the
    // closing marker.
    text = `${text.slice(0, room - 1).replace(/\\+$/u, '')}…`;
  }
  return `~~${text}~~`;
}

/**
 * The scope tag a success hero appends after the list name. Only
 * blacklist entries have a scope.
 * @param {string} type - black | white | watch
 * @param {string} scope - 'server' or 'global'
 * @param {string} lang - locale
 * @returns {string} a leading space and a code-wrapped tag, or ''
 */
export function formatListScopeTag(type, scope, lang) {
  if (type !== 'black') return '';
  return ` \`[${scopeLabel(scope, lang)}]\``;
}

/**
 * Build the inline field run of a list-entry success card: list, raid,
 * scope (blacklist only), server, item level and CP, padded to whole rows.
 * @param {object} options
 * @param {string} options.type - list type the entry is in now
 * @param {string} options.raid - raid label, '' when none
 * @param {string} options.scope - 'server' or 'global'
 * @param {object} options.entry - the list entry (name, allCharacters)
 * @param {Map<string, object>} [options.statMap] - roster snapshots by name key
 * @param {string} options.icon - list icon
 * @param {string} options.labelCap - list label
 * @param {string} options.lang - locale
 * @param {object} [options.previous] - values an edit replaced; a key is
 *   present only when that value changed: `list` ({ icon, labelCap }),
 *   `raid` ('' when there was none), `scope` ('server' | 'global')
 * @returns {Array<object>} inline embed fields, padded to whole rows
 */
export function buildListEntryInlineFields({
  type,
  raid,
  scope,
  entry,
  statMap = new Map(),
  icon,
  labelCap,
  lang,
  previous = {},
}) {
  const notAvailable = t('dialogue.broadcast.notAvailable', lang);
  const field = (label, value, changed, oldValue) => ({
    name: changed ? `${label}${CHANGED_MARK}` : label,
    value: changed ? `${formatStruckValue(oldValue)}\n${value}` : value,
    inline: true,
  });

  const inlineFields = [
    field(
      `📒 ${t('dialogue.listAdd.success.fields.list', lang)}`,
      `${icon} ${labelCap}`,
      'list' in previous,
      previous.list ? `${previous.list.icon} ${previous.list.labelCap}` : '',
    ),
    field(
      `🗡️ ${t('dialogue.listAdd.success.fields.raid', lang)}`,
      raid ? `\`${raid}\`` : notAvailable,
      'raid' in previous,
      previous.raid || notAvailable,
    ),
  ];
  if (type === 'black') {
    inlineFields.push(field(
      `🌐 ${t('dialogue.listAdd.success.fields.scope', lang)}`,
      scopeLabel(scope, lang),
      'scope' in previous,
      'scope' in previous ? scopeLabel(previous.scope, lang) : '',
    ));
  }
  // The server belongs to the roster, so a sibling's snapshot can answer
  // when the entry's own record has none.
  const world = resolveRosterWorld(entry, statMap);
  if (world) {
    inlineFields.push({ name: `🌍 ${t('dialogue.roster.server', lang)}`, value: `\`${world}\``, inline: true });
  }
  const statBadges = formatRosterStatBadges(statMap.get(normalizeNameKey(entry?.name)));
  if (statBadges.itemLevel) {
    inlineFields.push({ name: `📊 ${t('dialogue.broadcast.fields.itemLevel', lang)}`, value: statBadges.itemLevel, inline: true });
  }
  if (statBadges.combatPower) {
    inlineFields.push({ name: `⚔️ ${t('dialogue.broadcast.fields.combatPower', lang)}`, value: statBadges.combatPower, inline: true });
  }
  // Optional roster stats can leave a partial second row. Pad only after
  // every value is known so Discord never stretches a lone field.
  return padInlineRow(inlineFields);
}

/**
 * Build the full-width reason field. When an edit replaced the reason, the
 * old one is struck through above the new one and cut to fit the field;
 * the new reason is always shown whole.
 * @param {object} options
 * @param {string} options.reason - the reason now
 * @param {string} [options.previousReason] - the reason before the edit;
 *   omit it when the reason did not change
 * @param {string} options.lang - locale
 * @returns {{name: string, value: string, inline: boolean}}
 */
export function buildListEntryReasonField({ reason, previousReason, lang }) {
  const label = `📝 ${t('dialogue.listAdd.success.fields.reason', lang)}`;
  const notAvailable = t('dialogue.broadcast.notAvailable', lang);
  const current = (reason || notAvailable).slice(0, FIELD_VALUE_LIMIT);
  if (previousReason === undefined) return { name: label, value: current, inline: false };

  const room = FIELD_VALUE_LIMIT - current.length - 1;
  const value = room < MIN_STRUCK_REASON_LENGTH
    ? current
    : `${formatStruckValue(previousReason || notAvailable, room)}\n${current}`;
  return { name: `${label}${CHANGED_MARK}`, value, inline: false };
}

/**
 * Build the roster field of a list-entry success card: the entry's own
 * character first, then its tracked alts with class, item level and CP.
 * @param {object} options
 * @param {string[]} options.names - the entry's allCharacters
 * @param {string} options.primaryName - the entry's own character
 * @param {Map<string, object>} [options.statMap] - roster snapshots by name key
 * @param {string} [options.lang='en'] - locale
 * @param {string[]} [options.newNames=[]] - alts an edit just added, marked 🆕
 * @returns {{name: string, value: string, inline: boolean} | null}
 */
export function buildListEntryRostersField({
  names,
  primaryName,
  statMap = new Map(),
  lang = 'en',
  newNames = [],
}) {
  return renderTrackedAltsField({
    names,
    primaryName,
    statMap,
    includePrimary: true,
    label: `🧬 ${t('dialogue.listAdd.success.fields.trackedRosters', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
    newNames,
  });
}
