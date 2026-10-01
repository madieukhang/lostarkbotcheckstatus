/**
 * helpers.js
 * Pure helpers shared across the /la-list * command handlers. None of these
 * functions close over the Discord client, so they live outside the
 * createListHandlers factory.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { BLANK_FIELD_VALUE, COLORS, ICONS } from '../../utils/ui.js';
import { normalizeNameKey } from '../../utils/names.js';
import { t } from '../../services/i18n/index.js';
import { formatLinkedCharacter, renderTrackedAltsField } from './trackedAltsRender.js';
import { buildBroadcastEvidenceButton } from './evidence/broadcastButton.js';
import { buildNoteCountLine } from './notes/entryNotes.js';
import {
  buildListEntryInlineFields,
  buildListEntryReasonField,
  buildListEntryRostersField,
  formatListScopeTag,
} from './entryCardFields.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;
const MEMBER_APPROVER_IDS = config.memberApproverIds;

const LIST_CONTEXTS = Object.freeze({
  black: { model: Blacklist, label: 'blacklist', color: COLORS.danger, icon: '⛔' },
  white: { model: Whitelist, label: 'whitelist', color: COLORS.success, icon: '✅' },
  watch: { model: Watchlist, label: 'watchlist', color: COLORS.warning, icon: '⚠️' },
});

export function getListContext(type) {
  return LIST_CONTEXTS[type] || LIST_CONTEXTS.white;
}

export function listTypeIcon(type) {
  if (type === 'black') return LIST_CONTEXTS.black.icon;
  if (type === 'white') return LIST_CONTEXTS.white.icon;
  return LIST_CONTEXTS.watch.icon;
}

/**
 * Tack the visual tokens onto a list-entry document so it can flow into
 * `buildEvidenceEmbed` (and any other renderer that reads `_icon` /
 * `_label` / `_color`). Returns a shallow clone so the caller's input doc
 * isn't mutated.
 */
export function decorateListEntry(entry, listType) {
  const ctx = getListContext(listType);
  return {
    ...entry,
    _listType: listType,
    _icon: ctx.icon,
    _label: ctx.label,
    _color: ctx.color,
  };
}

/**
 * Mongo ObjectId regex · used by every `<type>:<_id>` autocomplete /
 * select-menu value encoding the bot ships (/la-evidence picker,
 * /la-check evidence dropdown). Centralised so the shape can evolve
 * (length tweak, separator change) in one place instead of three.
 */
const LIST_ENTRY_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Parse the canonical `<listType>:<_id>` value encoding used by every
 * dropdown / autocomplete the bot ships for list entries. Returns
 * `{ listType, id }` on a valid match (listType in {black, white,
 * watch} and id passes the Mongo ObjectId shape) or `null` otherwise.
 * Callers that also accept free-typed names should fall through to
 * a name-based lookup when this returns null.
 */
export function parseListEntryRef(raw) {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) return null;
  const listType = raw.slice(0, idx);
  if (listType !== 'black' && listType !== 'white' && listType !== 'watch') return null;
  const id = raw.slice(idx + 1).trim();
  if (!LIST_ENTRY_ID_RE.test(id)) return null;
  return { listType, id };
}

/**
 * Build a standardized embed for trusted user block messages.
 * Wraps the shared buildAlertEmbed with severity:'trusted' so trusted
 * blocks have consistent styling with the rest of the bot's alerts.
 */
export function buildTrustedBlockEmbed(name, reason, { via, lang = 'en' } = {}) {
  const rosterLink = rosterUrl(name);
  const description = t(`dialogue.trustedBlock.${via ? 'via' : 'direct'}`, lang, { name, via });

  return buildAlertEmbed({
    severity: AlertSeverity.TRUSTED,
    title: t('dialogue.trustedBlock.title', lang),
    description,
    fields: [
      { name: `👤 ${t('dialogue.trustedBlock.name', lang)}`, value: `[${name}](${rosterLink})`, inline: true },
      // Reason is prose, so it takes a full row instead of a third of the card.
      { name: `📝 ${t('dialogue.trustedBlock.reason', lang)}`, value: reason || t('dialogue.broadcast.notAvailable', lang), inline: false },
    ],
    lang,
  });
}

/**
 * Compare a list entry with its state before an edit, in the shapes the
 * entry card builders take: `previous` holds only the inline values that
 * changed, and `previousReason` is set only when the reason changed.
 * @param {object} options
 * @param {object} options.entry - the entry after the edit
 * @param {object} options.previousEntry - the entry before the edit
 * @param {string} options.type - list type after the edit
 * @param {string} [options.previousType] - list type before the edit
 * @param {boolean} [options.isMove] - the edit moved the entry to another
 *   list; defaults to comparing the two types
 * @param {string} options.lang - locale
 * @returns {{
 *   changed: {reason: boolean, list: boolean, raid: boolean, scope: boolean},
 *   previous: object,
 *   previousReason: (string|undefined),
 * }}
 */
export function describeListEntryEdit({
  entry,
  previousEntry,
  type,
  previousType = type,
  isMove = previousType !== type,
  lang,
}) {
  const scope = entry.scope || 'global';
  const changed = {
    reason: (entry.reason || '') !== (previousEntry.reason || ''),
    list: isMove,
    raid: (entry.raid || '') !== (previousEntry.raid || ''),
    // A move into blacklist sets a scope for the first time; plan.js does
    // not count that as a scope change, and neither do the cards.
    scope: !isMove && type === 'black' && scope !== (previousEntry.scope || 'global'),
  };

  const previous = {};
  if (changed.list) {
    previous.list = {
      icon: getListContext(previousType).icon,
      labelCap: t(`dialogue.broadcast.list.${previousType}`, lang),
    };
  }
  if (changed.raid) previous.raid = previousEntry.raid || '';
  if (changed.scope) previous.scope = previousEntry.scope || 'global';

  return {
    changed,
    previous,
    previousReason: changed.reason ? previousEntry.reason || '' : undefined,
  };
}

/**
 * The tail an edit hero or headline appends: the fields that changed, then
 * the number of alts added. Logs and evidence have no field on the cards,
 * so this is the only place that names them.
 * @param {object} options
 * @param {object} options.changed - from describeListEntryEdit
 * @param {boolean} [options.logsChanged=false] - the edit replaced the logs link
 * @param {boolean} [options.evidenceChanged=false] - the edit replaced the image
 * @param {number} [options.addedAltCount=0] - alts the edit added
 * @param {string} options.lang - locale
 * @returns {string} '' when the edit changed nothing named here
 */
export function formatListEditSummary({
  changed,
  logsChanged = false,
  evidenceChanged = false,
  addedAltCount = 0,
  lang,
}) {
  const changedLabels = [
    changed.reason && t('dialogue.listAdd.success.fields.reason', lang),
    changed.list && t('dialogue.listAdd.success.fields.list', lang),
    changed.raid && t('dialogue.listAdd.success.fields.raid', lang),
    changed.scope && t('dialogue.listAdd.success.fields.scope', lang),
    logsChanged && t('dialogue.listEdit.success.summaryFields.logs', lang),
    evidenceChanged && t('dialogue.listEdit.success.summaryFields.evidence', lang),
  ].filter(Boolean).map((label) => `**${label}**`);
  return [
    changedLabels.length > 0
      ? t('dialogue.listEdit.success.summaryChanged', lang, { fields: changedLabels.join(', ') })
      : '',
    addedAltCount > 0
      ? t('dialogue.listEdit.success.summaryAlts', lang, {
        count: addedAltCount,
        altWord: t(`dialogue.broadcast.${addedAltCount === 1 ? 'altOne' : 'altMany'}`, lang),
      })
      : '',
  ].join('');
}

/**
 * Build the main /la-list edit success card on the /la-list add card's
 * layout: the list icon and character name in the title, a hero line with
 * the editor and what changed, the add card's field run with replaced
 * values marked in place, the roster list with new alts marked, and an
 * editor footer. Replaced evidence is rendered by buildListEditSuccessEmbeds
 * as a before/after pair.
 * @param {object} entry - the entry after the edit
 * @param {object} options
 * @param {string} options.type - list type after the edit
 * @param {string} [options.previousType] - list type before the edit
 * @param {object} [options.previousEntry] - the entry before the edit
 * @param {boolean} [options.isMove=false] - the edit moved the entry to another list
 * @param {boolean} [options.logsChanged=false] - the edit replaced the logs link
 * @param {boolean} [options.evidenceChanged=false] - the edit replaced the image
 * @param {string[]} [options.addedAlts=[]] - alts the edit added
 * @param {string} options.editorName - display name of the member who edited
 * @param {Map<string, object>} [options.statMap] - roster snapshots by name key
 * @param {string} [options.freshDisplayUrl] - current evidence image, when it did not change
 * @param {string} [options.lang='en'] - locale
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildListEditSuccessEmbed(entry, options = {}) {
  const {
    type,
    previousType = type,
    previousEntry = entry,
    isMove = false,
    logsChanged = false,
    evidenceChanged = false,
    addedAlts = [],
    editorName,
    statMap = new Map(),
    freshDisplayUrl,
    lang = 'en',
  } = options;
  const { color, icon } = getListContext(type);
  const labelCap = t(`dialogue.broadcast.list.${type}`, lang);
  const scope = entry.scope || 'global';
  const { changed, previous, previousReason } = describeListEntryEdit({
    entry, previousEntry, type, previousType, isMove, lang,
  });

  const fields = buildListEntryInlineFields({
    type, raid: entry.raid, scope, entry, statMap, icon, labelCap, lang, previous,
  });
  fields.push(buildListEntryReasonField({ reason: entry.reason, previousReason, noteLine: buildNoteCountLine(entry, lang), lang }));
  const rostersField = buildListEntryRostersField({
    names: entry.allCharacters,
    primaryName: entry.name,
    statMap,
    lang,
    newNames: addedAlts,
  });
  if (rostersField) fields.push(rostersField);

  const summary = formatListEditSummary({
    changed, logsChanged, evidenceChanged, addedAltCount: addedAlts.length, lang,
  });

  const embed = buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: icon,
    color,
    title: t(`dialogue.listEdit.success.${isMove ? 'titleMoved' : 'titleEdited'}`, lang, {
      list: labelCap,
      name: entry.name,
    }),
    description: t('dialogue.listEdit.success.hero', lang, {
      user: editorName,
      name: formatLinkedCharacter(entry.name, statMap.get(normalizeNameKey(entry.name))),
      list: labelCap,
      scope: formatListScopeTag(type, scope, lang),
      summary,
    }),
    fields,
    footer: `${ICONS.shield} ${t('dialogue.listEdit.success.footer', lang, { user: editorName })}`,
    lang,
  });

  if (freshDisplayUrl) {
    embed.addFields({
      name: t('listView.evidence.attached', lang),
      value: t('dialogue.listAdd.success.evidence', lang, { url: freshDisplayUrl }),
      inline: false,
    });
    embed.setImage(freshDisplayUrl);
  }

  return embed;
}

/** Render changed evidence in order, with one Evidence heading for the pair. */
export function buildListEditSuccessEmbeds(entry, options = {}) {
  const {
    evidenceChanged = false,
    previousDisplayUrl = '',
    hadPreviousEvidence = false,
    freshDisplayUrl = '',
    lang = 'en',
  } = options;
  const main = buildListEditSuccessEmbed(entry, {
    ...options,
    freshDisplayUrl: evidenceChanged ? '' : freshDisplayUrl,
  });
  if (!evidenceChanged) return [main];

  const beforeLabel = t('dialogue.listEdit.evidence.before', lang);
  const unavailable = t('dialogue.listEdit.evidence.unavailable', lang);
  const beforeValue = previousDisplayUrl
    ? `**${beforeLabel}**`
    : `**${beforeLabel}:** ${hadPreviousEvidence ? unavailable : t('dialogue.listEdit.evidence.none', lang)}`;
  main.addFields({ name: t('listView.evidence.attached', lang), value: beforeValue, inline: false });
  if (previousDisplayUrl) main.setImage(previousDisplayUrl);

  const after = buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: '',
    color: getListContext(options.type).color,
    title: t('dialogue.listEdit.evidence.after', lang),
    description: freshDisplayUrl
      ? t('dialogue.listEdit.evidence.download', lang, { url: freshDisplayUrl })
      : unavailable,
    timestamp: false,
    lang,
  });
  if (freshDisplayUrl) after.setImage(freshDisplayUrl);
  return [main, after];
}

// Title, hero and footer of an approval card for the approvers' DM and for
// the requester's own copy of the same request.
const APPROVAL_CARD_VIEWS = Object.freeze({
  approver: {
    title: ({ isEdit, listIcon, payload, lang }) => t(`dialogue.approval.${isEdit ? 'titleEdit' : 'titleAdd'}`, lang, {
      icon: listIcon,
      name: payload.name,
    }),
    hero: ({ isEdit, guild, payload, listLabel, scopeTag, lang }) => t(`dialogue.approval.${isEdit ? 'heroEdit' : 'heroAdd'}`, lang, {
      guild: guild.name,
      name: payload.name,
      list: listLabel,
      scope: scopeTag,
    }),
    footer: (lang) => `${ICONS.shield} ${t('dialogue.approval.footer', lang)}`,
    color: (listColor) => listColor,
    showsRequester: true,
  },
  requester: {
    title: ({ payload, listLabel, lang }) => t('dialogue.approval.requester.title', lang, {
      list: listLabel,
      name: payload.name,
    }),
    hero: ({ payload, listLabel, scopeTag, lang }) => t('dialogue.approval.requester.hero', lang, {
      name: formatLinkedCharacter(payload.name, null),
      list: listLabel,
      scope: scopeTag,
    }),
    footer: (lang) => t('dialogue.approval.requester.footer', lang),
    // Blurple marks a request still waiting, whatever list it targets.
    color: () => COLORS.info,
    showsRequester: false,
  },
});

/**
 * Approval-DM card sent to senior + officer approvers when a non-bypass
 * member submits a /la-list add (or /la-list edit). Approvers review
 * many of these per day; the layout is optimised for fast scan:
 *
 *   - Title bar: shield icon + action verb + entry name
 *   - Hero line: who/where/which list + scope tag (`[Local]`/`[Global]`)
 *   - Inline meta (3-up): Type · Raid · Scope
 *   - Reason: full-width field, capped at 1024
 *   - Tracked alts: linked roster names so the approver can verify
 *     the request maps to the right account in one click
 *   - Requested by: full-width with mention so approvers can ping back
 *   - Request ID: full-width footer bar (also feeds the Approve button
 *     dispatch path so it must remain in the embed for audit trail)
 *
 * The list-type icon (⛔/✅/⚠️) is preferred over the generic shield
 * because approvers triage at a glance: a red ⛔ DM lands differently
 * from a green ✅ one even before they read the title.
 *
 * With `options.forRequester`, the same request renders as the requester's
 * own copy: a "sent for approval" title, hero and footer, and no
 * Requested by field.
 */
export function buildListAddApprovalEmbed(guild, payload, options = {}) {
  const view = APPROVAL_CARD_VIEWS[options.forRequester ? 'requester' : 'approver'];
  const lang = options.lang || 'en';
  const isEdit = payload.action === 'edit';

  const listContext = LIST_CONTEXTS[payload.type] || {
    icon: ICONS.shield,
    label: 'list',
    color: COLORS.info,
  };
  const { icon: listIcon, color: listColor } = listContext;
  const listLabel = t(`dialogue.broadcast.list.${payload.type}`, lang);
  const scopeTag = payload.scope === 'server'
    ? ` \`[${t('dialogue.approval.scopeTag.local', lang)}]\``
    : payload.scope === 'global'
      ? ` \`[${t('dialogue.approval.scopeTag.global', lang)}]\``
      : '';
  const context = { guild, payload, isEdit, listIcon, listLabel, scopeTag, lang };

  const title = options.title || view.title(context);
  const heroLine = view.hero(context);

  const fields = [
    { name: `📒 ${t('dialogue.approval.fields.list', lang)}`, value: `${listIcon} ${listLabel}`, inline: true },
    { name: `🗡️ ${t('dialogue.approval.fields.raid', lang)}`, value: payload.raid ? `\`${payload.raid}\`` : t('dialogue.broadcast.notAvailable', lang), inline: true },
    { name: `🌐 ${t('dialogue.approval.fields.scope', lang)}`, value: t(`dialogue.approval.scopeTag.${payload.scope === 'server' ? 'local' : 'global'}`, lang), inline: true },
    { name: `📝 ${t('dialogue.approval.fields.reason', lang)}`, value: (payload.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024), inline: false },
  ];

  // Tracked alts give the approver "is this the right person?" context
  // without forcing them to run /la-roster manually. Routed through the
  // shared renderer so this card stays visually identical to the broadcast
  // / la-list view evidence detail (numbering, link, overflow tail).
  // No statMap supplied · the approval-DM doesn't run a snapshot lookup,
  // so rows degrade to plain `[name](link)` rather than class+ilvl+CP.
  const altsField = renderTrackedAltsField({
    names: [...(payload.allCharacters || []), ...(payload.additionalNames || [])],
    primaryName: payload.name,
    label: `🧬 ${t('dialogue.approval.fields.trackedAlts', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
  fields.push(...[
    altsField,
    view.showsRequester
      ? {
          name: `👤 ${t('dialogue.approval.fields.requestedBy', lang)}`,
          value: `${payload.requestedByDisplayName} (<@${payload.requestedByUserId}>)`,
          inline: false,
        }
      : null,
  ].filter(Boolean));

  // Request ID stays below the business context and uses code formatting to
  // remain visually distinct and support server-side row lookup.
  fields.push({
    name: `🆔 ${t('dialogue.approval.fields.requestId', lang)}`,
    value: `\`${payload.requestId}\``,
    inline: false,
  });

  // No titleIcon override: the list icon (⛔/✅/⚠️) already provides the title
  // cue. A second shield prefix would duplicate it; the footer carries the
  // shield instead.
  const embed = buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: '',
    color: view.color(listColor),
    title,
    description: heroLine,
    fields,
    footer: view.footer(lang),
    lang,
  });

  if (payload.imageUrl) {
    // Heading for the embedded image, as on every other card that shows
    // one inline rather than behind a button.
    embed.addFields({
      name: t('listView.evidence.attached', lang),
      value: BLANK_FIELD_VALUE,
      inline: false,
    });
    embed.setImage(payload.imageUrl);
  }

  return embed;
}

const DECIDED_APPROVAL_STYLES = Object.freeze({
  approved: { icon: '✅', color: COLORS.success, resultLabel: 'Approved' },
  editApproved: { icon: '✅', color: COLORS.success, resultLabel: 'Approved' },
  noted: { icon: '📝', color: COLORS.success, resultLabel: 'Added to History' },
  returned: { icon: '⚠️', color: COLORS.warning, resultLabel: 'Processed' },
  rejected: { icon: '✖️', color: COLORS.greyDark, resultLabel: 'Rejected' },
  kept: { icon: '✖️', color: COLORS.greyDark, resultLabel: 'Kept Existing' },
});

/**
 * Rebuild an approval DM card once it is decided, so the approver keeps a
 * record of what they decided: every field of the request stays, the
 * title and colour show the outcome, and a Decision field names who
 * decided and when. The inline evidence image and its heading go because
 * its link came from the pending request, which deciding deletes; the
 * archive button of buildDecidedApprovalPayload opens it instead.
 * @param {object} options
 * @param {import('discord.js').Client} options.client - resolves the
 *   origin guild's name for the hero line
 * @param {object} options.payload - the decided request
 * @param {keyof typeof DECIDED_APPROVAL_STYLES} options.outcome - what happened
 * @param {string} options.approver - tag of the approver who decided
 * @param {string} [options.result=''] - why the executor refused, for 'returned'
 * @param {string} options.lang - the approver's language
 * @returns {import('discord.js').EmbedBuilder} the decided card
 */
export function buildDecidedApprovalEmbed({ client, payload, outcome, approver, result = '', lang }) {
  const { icon, color } = DECIDED_APPROVAL_STYLES[outcome];
  const guild = client.guilds.cache.get(payload.guildId) ?? { name: payload.guildId };
  const title = t('dialogue.approval.decided.title', lang, {
    title: t(`dialogue.approval.${payload.action === 'edit' ? 'titleEdit' : 'titleAdd'}`, lang, { icon, name: payload.name }),
    outcome: t(`dialogue.approval.decided.outcomes.${outcome}`, lang),
  });
  const embed = buildListAddApprovalEmbed(guild, payload, { lang, title });
  const evidenceHeading = t('listView.evidence.attached', lang);
  return embed
    .setColor(color)
    .setImage(null)
    .setFields(
      ...embed.data.fields.filter((field) => field.name !== evidenceHeading),
      {
        name: `${ICONS.shield} ${t('dialogue.approval.decided.field', lang)}`,
        value: t(`dialogue.approval.decided.lines.${outcome}`, lang, {
          user: approver,
          time: `<t:${Math.floor(Date.now() / 1000)}:R>`,
          result,
        }),
        inline: false,
      },
    )
    .setFooter({ text: t('dialogue.approval.decided.footer', lang) });
}

/**
 * The whole decided approval DM: the decided card, a disabled button
 * naming the outcome and, when the request carried evidence, a button that
 * opens it from the archive without the deleted pending request.
 * @param {object} options - as buildDecidedApprovalEmbed takes them
 * @returns {{content: null, embeds: object[], components: object[]}}
 */
export function buildDecidedApprovalPayload(options) {
  const { payload, outcome, lang } = options;
  const row = buildApprovalResultRow(DECIDED_APPROVAL_STYLES[outcome].resultLabel, lang);
  const evidenceButton = buildBroadcastEvidenceButton(payload, { lang });
  if (evidenceButton) row.addComponents(evidenceButton);
  return { content: null, embeds: [buildDecidedApprovalEmbed(options)], components: [row] };
}

/**
 * Build approval-DM recipients while preserving the configured senior order.
 * At most one random officer is appended. Overlapping roles never receive
 * duplicate DMs, and senior-only approvals use the same ordered recipient list.
 * @returns {string[]} unique Discord user IDs
 */
export function getApproverRecipientIds() {
  const recipientIds = getSeniorApproverIds();

  if (OFFICER_APPROVER_IDS.length > 0) {
    const randomOfficerId = OFFICER_APPROVER_IDS[Math.floor(Math.random() * OFFICER_APPROVER_IDS.length)];
    if (!recipientIds.includes(randomOfficerId)) {
      recipientIds.push(randomOfficerId);
    }
  }

  return recipientIds;
}

export function isRequesterAutoApprover(userId) {
  return Boolean(userId) && [
    SENIOR_APPROVER_IDS,
    OFFICER_APPROVER_IDS,
    MEMBER_APPROVER_IDS,
  ].some((ids) => ids.includes(userId));
}

/**
 * Stricter variant used by /la-list multiadd auto-approve check.
 * Only senior + officer can bypass bulk approval; MEMBER_APPROVER_IDS
 * (which gives bypass rights on single /la-list add for legacy reasons)
 * does NOT confer bulk-add auto-approval. This matches the README claim
 * that only officers/seniors auto-approve multiadd batches.
 */
export function isOfficerOrSenior(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
  return OFFICER_APPROVER_IDS.includes(userId);
}

/**
 * Senior-only recipient list for /la-list multiadd bulk approval DMs.
 * Unlike getApproverRecipientIds (which mixes in a random officer), this
 * returns exclusively SENIOR_APPROVER_IDS - bulk batches are a high-impact
 * operation that should always be reviewed by a Senior.
 */
export function getSeniorApproverIds() {
  const seen = new Set();
  const out = [];
  for (const id of SENIOR_APPROVER_IDS) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function localizeApprovalResultLabel(actionLabel, lang) {
  const keyByLabel = {
    Approved: 'common.actions.approved',
    Rejected: 'common.actions.rejected',
    Processed: 'common.actions.processed',
    Failed: 'common.actions.failed',
    Blocked: 'common.actions.blocked',
    'Kept Existing': 'common.actions.keptExisting',
    'Added to History': 'common.actions.addedToHistory',
  };
  const key = keyByLabel[actionLabel];
  return key ? t(key, lang) : actionLabel;
}

export function buildApprovalResultRow(actionLabel, lang = 'en') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_approved_done')
      .setLabel(localizeApprovalResultLabel(actionLabel, lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

/** Keep the chosen action reachable after a restart or transient failure. */
export function buildApprovalRetryRow(action, requestId, lang = 'en') {
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`${action}:${requestId}`)
    .setLabel(t('dialogue.approval.flow.retry', lang))
    .setStyle(ButtonStyle.Secondary));
}
