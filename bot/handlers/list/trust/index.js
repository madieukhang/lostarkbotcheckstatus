import { connectDB } from '../../../db.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import config from '../../../config.js';
import Blacklist from '../../../models/Blacklist.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { buildRosterCharacters } from '../../../services/roster/index.js';
import { normalizeCharacterName, normalizeRosterNames } from '../../../utils/names.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed, replyAlert } from '../../../utils/interactionReplies.js';
import { COLORS } from '../../../utils/ui.js';
import {
  renderTrackedAltsField,
  statMapFromRosterCharacters,
} from '../trackedAltsRender.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;

export function createTrustHandlers() {
  async function handleListTrustCommand(interaction) {
    const userId = interaction.user.id;
    const isOfficerOrSenior = OFFICER_APPROVER_IDS.includes(userId) || SENIOR_APPROVER_IDS.includes(userId);

    if (!isOfficerOrSenior) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Officer-Only Command',
        description: 'Only officers and seniors can manage the trusted list.',
      });
      return;
    }

    const action = interaction.options.getString('action', true);
    const rawName = interaction.options.getString('name', true);
    const name = normalizeCharacterName(rawName);
    const reason = interaction.options.getString('reason') || '';

    await deferReply(interaction);
    await connectDB();

    if (action === 'remove') {
      const deleted = await TrustedUser.findOneAndDelete(buildNameRosterQuery([name]))
        .collation({ locale: 'en', strength: 2 });
      if (!deleted) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Not Trusted',
          description: `**${name}** is not in the trusted list, so there's nothing to remove.`,
        });
        return;
      }

      const rosterLink = rosterUrl(deleted.name);
      const trustedSince = deleted.createdAt
        ? `<t:${Math.floor(new Date(deleted.createdAt).getTime() / 1000)}:R>`
        : 'unknown';

      const embed = buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        titleIcon: '',
        color: COLORS.muted,
        title: `🛡️ Trusted · Removed · ${deleted.name}`,
        description:
          `**${deleted.name}** is no longer on the trusted list. ` +
          `This character and any linked roster alts can now be added to ` +
          `the blacklist / watchlist again.`,
        fields: [
          { name: '🧬 Character', value: `[${deleted.name}](${rosterLink})`, inline: true },
          { name: '📝 Was trusted for', value: (deleted.reason || 'N/A').slice(0, 1024), inline: true },
          { name: '🕐 Trusted since', value: trustedSince, inline: true },
          { name: '👤 Removed by', value: interaction.user.tag, inline: false },
        ],
        footer: 'Tip: /la-list trust action:add to re-trust if this was a mistake.',
      });

      await editEmbed(interaction, embed);

      console.log(`[list] Trusted user removed: ${deleted.name} by ${interaction.user.tag}`);
      return;
    }

    // action === 'add'
    const existing = await TrustedUser.findOne(buildNameRosterQuery([name]))
      .collation({ locale: 'en', strength: 2 });
    if (existing) {
      const isExactExisting = existing.name.toLowerCase() === name.toLowerCase();
      if (!isExactExisting) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Already Trusted',
          description: `**${name}** is already trusted via roster match with **${existing.name}**.`,
        });
        return;
      }
    }

    const rosterResult = await buildRosterCharacters(name, {
      hiddenRosterFallback: true,
    });
    const allCharacters = normalizeRosterNames(
      name,
      rosterResult?.hasValidRoster ? rosterResult.allCharacters : []
    );

    const rosterTrustedQuery = existing
      ? { $and: [buildNameRosterQuery(allCharacters), { _id: { $ne: existing._id } }] }
      : buildNameRosterQuery(allCharacters);
    const existingRosterTrusted = await TrustedUser.findOne(rosterTrustedQuery)
      .collation({ locale: 'en', strength: 2 });
    if (existingRosterTrusted) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Already Trusted',
        description: existingRosterTrusted.name.toLowerCase() === name.toLowerCase()
          ? `**${existingRosterTrusted.name}** is already in the trusted list.`
          : `**${name}** is already trusted via roster match with **${existingRosterTrusted.name}**.`,
      });
      return;
    }

    if (!existing) {
      const trustGuildId = interaction.guild?.id || '';
      const blacklisted = await Blacklist.findOne(
        buildBlacklistQuery(buildNameRosterQuery(allCharacters), trustGuildId)
      ).collation({ locale: 'en', strength: 2 }).lean();
      if (blacklisted) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Blacklisted Character',
          description: `**${name}** is currently blacklisted (entry: **${blacklisted.name}**).`,
          footer: 'Remove the blacklist entry first before trusting this character.',
        });
        return;
      }

      await TrustedUser.create({
        name,
        reason,
        allCharacters,
        enrichmentSource: rosterResult?.hasValidRoster ? 'bible' : 'manual',
        enrichedAt: new Date(),
        addedByUserId: userId,
        addedByTag: interaction.user.tag,
      });
    } else {
      await TrustedUser.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...(reason ? { reason } : {}),
            allCharacters,
            enrichmentSource: rosterResult?.hasValidRoster ? 'bible' : 'manual',
            enrichedAt: new Date(),
          },
        }
      );
    }

    const rosterLink = rosterUrl(name);
    const actionLabel = existing ? 'Refreshed' : 'Added';
    const displayReason = reason || existing?.reason || '';
    const altsField = renderTrackedAltsField({
      names: allCharacters,
      primaryName: name,
      statMap: statMapFromRosterCharacters(rosterResult?.rosterCharacters || []),
      emptySentinel: '_Only this character is linked on this trusted entry._',
    });
    const fields = [
      { name: '🧬 Character', value: `[${name}](${rosterLink})`, inline: true },
      { name: '📝 Reason', value: (displayReason || 'N/A').slice(0, 1024), inline: true },
      { name: existing ? '👤 Refreshed by' : '👤 Added by', value: interaction.user.tag, inline: true },
    ];
    if (altsField) fields.push(altsField);

    const embed = buildAlertEmbed({
      severity: AlertSeverity.SUCCESS,
      titleIcon: '',
      color: COLORS.trustedSoft,
      title: `🛡️ Trusted · ${actionLabel} · ${name}`,
      description:
        `**${name}** is now on the trusted list. From this point on, ` +
        `**${name}** and any linked roster alt cannot be added to the ` +
        `blacklist, whitelist, or watchlist by anyone.`,
      fields,
      footer: 'Tip: /la-list view trusted to browse the trusted roster.',
    });

    await editEmbed(interaction, embed);

    console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
  }

  return { handleListTrustCommand };
}
