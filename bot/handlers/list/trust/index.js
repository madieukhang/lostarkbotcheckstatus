import { connectDB } from '../../../db.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import config from '../../../config.js';
import Blacklist from '../../../models/Blacklist.js';
import TrustedUser from '../../../models/TrustedUser.js';
import UserPreference from '../../../models/UserPreference.js';
import { buildRosterCharacters } from '../../../services/roster/index.js';
import { normalizeCharacterName, normalizeRosterNames } from '../../../utils/names.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed, replyAlert } from '../../../utils/interactionReplies.js';
import { COLORS } from '../../../utils/ui.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
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
    const lang = await getUserLanguage(userId, { UserPreferenceModel: UserPreference });

    if (!isOfficerOrSenior) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.trust.officerOnly', lang),
        lang,
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
          ...t('dialogue.trust.notTrusted', lang, { name }),
          lang,
        });
        return;
      }

      const rosterLink = rosterUrl(deleted.name);
      const trustedSince = deleted.createdAt
        ? `<t:${Math.floor(new Date(deleted.createdAt).getTime() / 1000)}:R>`
        : t('dialogue.trust.removed.unknown', lang);

      const embed = buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        titleIcon: '',
        color: COLORS.muted,
        title: `🛡️ ${t('dialogue.trust.removed.title', lang, { name: deleted.name })}`,
        description: t('dialogue.trust.removed.description', lang, { name: deleted.name }),
        fields: [
          { name: `🧬 ${t('dialogue.trust.removed.character', lang)}`, value: `[${deleted.name}](${rosterLink})`, inline: true },
          { name: `📝 ${t('dialogue.trust.removed.reason', lang)}`, value: (deleted.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024), inline: true },
          { name: `🕐 ${t('dialogue.trust.removed.since', lang)}`, value: trustedSince, inline: true },
          { name: `👤 ${t('dialogue.trust.removed.removedBy', lang)}`, value: interaction.user.tag, inline: false },
        ],
        footer: t('dialogue.trust.removed.footer', lang),
        lang,
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
          title: t('dialogue.trust.already.title', lang),
          description: t('dialogue.trust.already.via', lang, { name, matched: existing.name }),
          lang,
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
        title: t('dialogue.trust.already.title', lang),
        description: existingRosterTrusted.name.toLowerCase() === name.toLowerCase()
          ? t('dialogue.trust.already.direct', lang, { name: existingRosterTrusted.name })
          : t('dialogue.trust.already.via', lang, { name, matched: existingRosterTrusted.name }),
        lang,
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
          ...t('dialogue.trust.blacklisted', lang, { name, matched: blacklisted.name }),
          lang,
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
    const actionLabel = t(`dialogue.trust.${existing ? 'actionRefreshed' : 'actionAdded'}`, lang);
    const displayReason = reason || existing?.reason || '';
    const altsField = renderTrackedAltsField({
      names: allCharacters,
      primaryName: name,
      statMap: statMapFromRosterCharacters(rosterResult?.rosterCharacters || []),
      emptySentinel: `_${t('dialogue.trust.success.onlyCharacter', lang)}_`,
      label: `🧬 ${t('dialogue.trust.success.trackedAlts', lang)}`,
      overflowTemplate: t('dialogue.broadcast.more', lang),
    });
    const fields = [
      { name: `🧬 ${t('dialogue.trust.success.character', lang)}`, value: `[${name}](${rosterLink})`, inline: true },
      { name: `📝 ${t('dialogue.trust.success.reason', lang)}`, value: (displayReason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024), inline: true },
      { name: `👤 ${t(`dialogue.trust.success.${existing ? 'refreshedBy' : 'addedBy'}`, lang)}`, value: interaction.user.tag, inline: true },
    ];
    if (altsField) fields.push(altsField);

    const embed = buildAlertEmbed({
      severity: AlertSeverity.SUCCESS,
      titleIcon: '',
      color: COLORS.trustedSoft,
      title: `🛡️ ${t('dialogue.trust.success.title', lang, { action: actionLabel, name })}`,
      description: t('dialogue.trust.success.description', lang, { name }),
      fields,
      footer: t('dialogue.trust.success.footer', lang),
      lang,
    });

    await editEmbed(interaction, embed);

    console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
  }

  return { handleListTrustCommand };
}
