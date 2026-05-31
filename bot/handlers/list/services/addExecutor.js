/**
 * handlers/list/services/addExecutor.js
 * The actual add-to-DB executor + the hidden-roster guidance embed
 * builder. Both /la-list add (auto-approve + approval-approved paths)
 * and the approval-button handler call into executeListAddToDatabase
 * here · this is the single place that persists, stamps enrichment
 * metadata, runs dupe checks, and renders the success card.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchCharacterMeta,
  fetchNameSuggestions,
} from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { ICONS } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { rosterUrl, logsUrl } from '../../../utils/rosterLink.js';
import {
  renderTrackedAltsField,
  statMapFromRosterCharacters,
} from '../trackedAltsRender.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
} from '../helpers.js';

export function buildHiddenRosterGuidance(entryName, guildName, lang = 'en') {
  const hasGuild = Boolean(String(guildName || '').trim());
  const fields = [{
    name: `${ICONS.search} Hidden roster detected`,
    value: hasGuild
      ? (
          'Only the typed name is on the entry right now. ' +
          `Bible shows guild **${guildName}**, so you can run ` +
          `\`/la-list enrich name:${entryName}\` or press **Enrich now** below ` +
          'to scan guildmates for same-stronghold alts and append matches to `allCharacters`.'
        )
      : (
          'Only the typed name is on the entry right now. ' +
          '`/la-list enrich` needs a visible guild member list, but bible does not show a guild for this character. ' +
          `Use \`/la-list edit name:${entryName} additional_names:Alt1, Alt2\` to append known alts manually.`
        ),
    inline: false,
  }];

  const components = [];
  if (hasGuild) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`list-add:enrich-hidden:${encodeURIComponent(entryName)}`)
          .setLabel(t('common.actions.enrichNow', lang))
          .setEmoji(ICONS.search)
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  return { fields, components };
}

/**
 * Build the executeListAddToDatabase executor.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   (used by the hidden-roster guidance "Enrich now" button + the
 *   success card's evidence-rehost path)
 * @param {Function} deps.broadcastListChange - guild broadcast helper
 *   called after a successful add so the per-guild notify channel
 *   gets the update.
 * @returns {{executeListAddToDatabase: Function}} the executor (shared
 *   call site between auto-approve + approval-button paths).
 */
export function createListAddExecutor({ client, broadcastListChange }) {
  async function executeListAddToDatabase(payload) {
    const { model, label, color, icon } = getListContext(payload.type);
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const name = normalizeCharacterName(payload.name);

    // Step 0: Trusted user guard (exact name check · fast, before roster fetch)
    //
    // Note on `content` strings in non-ok returns: the user-facing reply
    // suppresses content when an embed is present (see add/command.js
    // line ~110). The string is kept for log-style consumers · bulk
    // results and approval-flow error fallbacks read result.content for
    // a one-line description of why the executor refused.
    {
      const trustedExact = await TrustedUser.findOne({ $or: [{ name }, { allCharacters: name }] })
        .collation({ locale: 'en', strength: 2 }).lean();
      if (trustedExact) {
        const via = trustedExact.name.toLowerCase() === name.toLowerCase()
          ? {}
          : { via: trustedExact.name };
        return {
          ok: false,
          content: `${name} is a trusted user and cannot be added to any list.`,
          embeds: [buildTrustedBlockEmbed(name, trustedExact.reason, via)],
        };
      }
    }

    // Step 1: Check if character exists
    const {
      hasValidRoster,
      allCharacters,
      targetItemLevel,
      rosterVisibility,
      rosterCharacters,
    } = await buildRosterCharacters(name, {
      hiddenRosterFallback: true,
    });
    const hiddenRosterMeta = rosterVisibility === 'hidden'
      ? await fetchCharacterMeta(name)
      : null;
    if (!hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name) || [];
      if (suggestions.length > 0) {
        const suggestionLines = suggestions
          .slice(0, 10)
          .map(
            (s, idx) =>
              `**${idx + 1}.** [${s.name}](${rosterUrl(s.name)}) · \`${Number(s.itemLevel || 0).toFixed(2)}\` · ${getClassName(s.cls)}`
          )
          .join('\n');

        return {
          ok: false,
          content: `No roster found for ${name}; ${suggestions.length} similar name(s) suggested.`,
          embeds: [
            buildAlertEmbed({
              severity: AlertSeverity.ERROR,
              title: 'No Roster Found',
              description: `No character named **${name}** was found on lostark.bible. Here are some similar names:`,
              fields: [
                { name: 'Suggestions', value: suggestionLines.slice(0, 1024), inline: false },
              ],
              footer: 'Pick one of the suggested names and re-run the command.',
            }),
          ],
        };
      }

      return {
        ok: false,
        content: `No roster found for ${name}, no similar names suggested.`,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'No Roster Found',
            description: `No character named **${name}** was found on lostark.bible, and no similar names were suggested.`,
            footer: 'Check the spelling (Lost Ark names are case-sensitive and include diacritics).',
          }),
        ],
      };
    }

    // Step 2: Check ilvl >= 1700 (using exact ilvl from roster, not regex on HTML)
    if (targetItemLevel !== null && targetItemLevel < 1700) {
      return {
        ok: false,
        content: `${name} has item level ${targetItemLevel.toFixed(2)} (below 1700).`,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Item Level Too Low',
            description: `**${name}** does not meet the minimum item level required to be added to any list.`,
            fields: [
              { name: 'Character', value: `[${name}](${rosterUrl(name)})`, inline: true },
              { name: 'Item level', value: `\`${targetItemLevel.toFixed(2)}\``, inline: true },
              { name: 'Minimum required', value: '`1700.00`', inline: true },
              { name: 'Target list', value: labelCap, inline: true },
            ],
            footer: 'ilvl gate prevents spam entries for inactive or unleveled alts.',
          }),
        ],
      };
    }

    // Step 2b: Trusted user guard (alt check · after roster gives us allCharacters)
    if (allCharacters.length > 0) {
      const trustedAlt = await TrustedUser.findOne({
        $or: [
          { name: { $in: allCharacters } },
          { allCharacters: { $in: allCharacters } },
        ],
      })
        .collation({ locale: 'en', strength: 2 }).lean();
      if (trustedAlt) {
        return {
          ok: false,
          content: `${name} shares a roster with trusted user ${trustedAlt.name}.`,
          embeds: [buildTrustedBlockEmbed(name, trustedAlt.reason, { via: trustedAlt.name })],
        };
      }
    }

    // Step 3: Check if already in list (scope-aware for blacklist)
    await connectDB();

    const entryScope = payload.scope || 'global';
    const entryGuildId = entryScope === 'server' ? (payload.guildId || '') : '';

    let dupeQuery;
    if (payload.type === 'black') {
      // For blacklist: check global + this server's entries (avoid redundant adds)
      dupeQuery = {
        $and: [
          { $or: [{ name }, { allCharacters: name }] },
          { $or: [
            { scope: 'global' },
            { scope: { $exists: false } }, // backward compat: old entries without scope
            ...(entryGuildId ? [{ scope: 'server', guildId: entryGuildId }] : []),
          ] },
        ],
      };
    } else {
      dupeQuery = { $or: [{ name }, { allCharacters: name }] };
    }

    const existed = await model.findOne(dupeQuery)
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (existed) {
      const isRosterMatch = existed.name.toLowerCase() !== name.toLowerCase();

      // Build structured alert embed with all the duplicate's context
      const existedRosterLink = rosterUrl(existed.name);
      const dupFields = [];
      if (isRosterMatch) {
        dupFields.push({
          name: 'Match type',
          value: 'Roster alt',
          inline: true,
        });
        dupFields.push({
          name: 'Matched name',
          value: `[${existed.name}](${existedRosterLink})`,
          inline: true,
        });
      } else {
        dupFields.push({
          name: 'Match type',
          value: 'Exact name',
          inline: true,
        });
      }
      if (existed.scope) {
        dupFields.push({
          name: 'Scope',
          value: existed.scope === 'server' ? '`[Server]`' : '`[Global]`',
          inline: true,
        });
      }
      if (existed.addedByDisplayName || existed.addedByTag) {
        dupFields.push({
          name: 'Added by',
          value: existed.addedByDisplayName || existed.addedByTag,
          inline: true,
        });
      }
      if (existed.reason) {
        dupFields.push({
          name: 'Existing reason',
          value: existed.reason.slice(0, 1024),
          inline: false,
        });
      }
      if (existed.raid) {
        dupFields.push({
          name: 'Raid',
          value: existed.raid,
          inline: true,
        });
      }

      const dupDescription = isRosterMatch
        ? `**${name}** is already in ${label} via roster match with **${existed.name}**.`
        : `**${name}** is already in ${label}.`;

      const dupContent = isRosterMatch
        ? `${name} already exists in ${label} (roster match: ${existed.name}).`
        : `${name} already exists in ${label}.`;

      return {
        ok: false,
        isDuplicate: true,
        existingEntry: existed,
        content: dupContent,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: `Already in ${labelCap}`,
            description: dupDescription,
            fields: dupFields,
            footer: `Use /la-list view ${payload.type} to see the full entry, or /la-list edit to modify it.`,
          }),
        ],
      };
    }

    // Step 4: Create entry
    const createData = {
      name,
      reason: payload.reason,
      raid: payload.raid,
      logsUrl: payload.logsUrl || '',
      // Image storage: prefer rehosted (permanent) over direct URL (legacy/expiring)
      imageUrl: payload.imageMessageId ? '' : (payload.imageUrl || ''),
      imageMessageId: payload.imageMessageId || '',
      imageChannelId: payload.imageChannelId || '',
      allCharacters,
      // allCharacters here always came through buildRosterCharacters
      // (visible OR hidden-roster fallback both consult bible), so the
      // enrichment is bible-sourced. enrichedAt stamps the create time
      // so future re-enrich loops can spot stale entries.
      enrichmentSource: 'bible',
      enrichedAt: new Date(),
      addedByUserId: payload.requestedByUserId,
      addedByTag: payload.requestedByTag,
      addedByName: payload.requestedByName,
      addedByDisplayName: payload.requestedByDisplayName,
    };

    // Add scope fields for blacklist entries
    if (payload.type === 'black') {
      createData.scope = entryScope;
      createData.guildId = entryGuildId;
    }

    const entry = await model.create(createData);

    // Build success embed using the same vocabulary as the approval
    // card (buildListAddApprovalEmbed) so an officer reviewing both
    // sees a consistent layout: list-type icon in the title bar, hero
    // line describing the action in plain English, icon-prefixed
    // fields (📒/🗡️/🌐/📝/🧬/🔗), numbered tracked-alts with class
    // icon + ilvl when the roster scrape surfaced them, and a footer
    // crediting the requester + roster source.
    const rosterLink = rosterUrl(entry.name);
    const autoLogsLink = logsUrl(entry.name);

    const linkParts = [`[Roster](${rosterLink})`, `[Logs](${autoLogsLink})`];
    if (payload.logsUrl) linkParts.push(`[Evidence Logs](${payload.logsUrl})`);

    const scopeTag = (payload.type === 'black' && entryScope === 'server')
      ? ' `[Local]`'
      : payload.type === 'black' ? ' `[Global]`' : '';
    const rosterSourceLabel = rosterVisibility === 'hidden'
      ? 'hidden roster fallback'
      : 'visible roster';

    // Tracked alts via shared renderer · class icon + ilvl come from the
    // rosterCharacters parse buildRosterCharacters returned for this name.
    // Visible-roster path supplies the statMap; hidden-roster path (which
    // returns just [name]) naturally falls through to the empty sentinel.
    const altsField = renderTrackedAltsField({
      names: allCharacters,
      primaryName: entry.name,
      statMap: statMapFromRosterCharacters(rosterCharacters),
      emptySentinel: '_Only this character is tracked on this entry._',
    });

    const requesterName = payload.requestedByDisplayName || payload.requestedByName || 'an officer';
    const heroLine = `**${requesterName}** added **${entry.name}** to the **${label}**${scopeTag}.`;

    const fields = [
      { name: '📒 List', value: `${icon} ${label}`, inline: true },
      { name: '🗡️ Raid', value: payload.raid ? `\`${payload.raid}\`` : 'N/A', inline: true },
    ];
    if (payload.type === 'black') {
      fields.push({ name: '🌐 Scope', value: entryScope, inline: true });
    }
    fields.push({ name: '📝 Reason', value: (payload.reason || 'N/A').slice(0, 1024), inline: false });
    if (altsField) fields.push(altsField);
    fields.push({ name: '🔗 Links', value: linkParts.join(' · '), inline: false });

    // titleIcon prefixes done + list-type. For whitelist (✅) we drop
    // the done prefix to avoid a doubled tick (✅ ✅) and let the list
    // icon carry the success cue on its own.
    const titleIcon = payload.type === 'white' ? icon : `${ICONS.done} ${icon}`;

    const embed = buildAlertEmbed({
      severity: AlertSeverity.SUCCESS,
      titleIcon,
      color,
      title: `${labelCap} · Added · ${entry.name}`,
      description: heroLine,
      fields,
      footer: `${ICONS.shield} Added by ${requesterName} · ${rosterSourceLabel}`,
    });

    // Resolve the freshest possible image URL from the just-created entry.
    // payload.imageUrl is unsafe here because for approval-delayed adds the
    // payload was snapshotted >24h ago and its URL may be expired. Going
    // through resolveDisplayImageUrl() guarantees a freshly-signed URL from
    // the rehosted message at THIS moment, regardless of payload age.
    const freshDisplayUrl = await resolveDisplayImageUrl(entry, client);
    if (freshDisplayUrl) {
      embed.setImage(freshDisplayUrl);
    }

    // Global: broadcast to all opted-in servers
    // Server-scoped: broadcast only to owner guild (special privilege)
    // skipBroadcast: used by /la-list multiadd bulk flow to gather one summary broadcast instead of N spam
    if (!payload.skipBroadcast) {
      // Pass the already-resolved fresh URL so broadcastListChange does not
      // re-fetch the same evidence message a second time.
      broadcastListChange('added', entry, payload, {
        onlyOwner: entryScope === 'server',
        displayUrl: freshDisplayUrl,
        rosterCharacters,
      }).catch((err) =>
        console.warn('[list] Broadcast failed:', err.message)
      );
    }

    // Hidden roster: surface next-step guidance. Enrich requires a guild
    // member list, so only render the button when bible exposes guildName;
    // otherwise direct officers to manual additional_names.
    const components = [];
    if (rosterVisibility === 'hidden') {
      const guidance = buildHiddenRosterGuidance(entry.name, hiddenRosterMeta?.guildName, payload.lang);
      embed.addFields(...guidance.fields);
      components.push(...guidance.components);
    }

    return {
      ok: true,
      entry, // Mongoose doc for callers that need to re-use the created entry (e.g. bulk broadcast)
      // content honors the executor contract documented above: every return
      // path (ok or not) carries a one-line string so approval-flow notifiers
      // can render `<@requester> ${content}` without a literal "undefined".
      content: `✅ Add approved: **${entry.name}** added to ${label}.`,
      embeds: [embed],
      components,
    };
  }

  return executeListAddToDatabase;
}
