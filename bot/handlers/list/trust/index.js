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

function buildRemovedTrustEmbed(deleted, interaction, lang) {
  const trustedSince = deleted.createdAt
    ? `<t:${Math.floor(new Date(deleted.createdAt).getTime() / 1000)}:R>`
    : t('dialogue.trust.removed.unknown', lang);
  return buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    titleIcon: '',
    color: COLORS.muted,
    title: `🛡️ ${t('dialogue.trust.removed.title', lang, { name: deleted.name })}`,
    description: t('dialogue.trust.removed.description', lang, { name: deleted.name }),
    fields: [
      { name: `🧬 ${t('dialogue.trust.removed.character', lang)}`, value: `[${deleted.name}](${rosterUrl(deleted.name)})`, inline: true },
      { name: `📝 ${t('dialogue.trust.removed.reason', lang)}`, value: (deleted.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024), inline: false },
      { name: `🕐 ${t('dialogue.trust.removed.since', lang)}`, value: trustedSince, inline: true },
      { name: `👤 ${t('dialogue.trust.removed.removedBy', lang)}`, value: interaction.user.tag, inline: false },
    ],
    footer: t('dialogue.trust.removed.footer', lang),
    lang,
  });
}

async function handleTrustRemoval(interaction, name, lang) {
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
  await editEmbed(interaction, buildRemovedTrustEmbed(deleted, interaction, lang));
  console.log(`[list] Trusted user removed: ${deleted.name} by ${interaction.user.tag}`);
}

async function replyExistingTrust(interaction, name, existing, lang) {
  await editAlert(interaction, {
    severity: AlertSeverity.WARNING,
    title: t('dialogue.trust.already.title', lang),
    description: existing.name.toLowerCase() === name.toLowerCase()
      ? t('dialogue.trust.already.direct', lang, { name: existing.name })
      : t('dialogue.trust.already.via', lang, { name, matched: existing.name }),
    lang,
  });
}

async function findRosterTrustConflict(existing, allCharacters) {
  const query = existing
    ? { $and: [buildNameRosterQuery(allCharacters), { _id: { $ne: existing._id } }] }
    : buildNameRosterQuery(allCharacters);
  return TrustedUser.findOne(query).collation({ locale: 'en', strength: 2 });
}

async function rejectBlacklistedTrust(interaction, name, allCharacters, lang) {
  const guildId = interaction.guild?.id || '';
  const blacklisted = await Blacklist.findOne(
    buildBlacklistQuery(buildNameRosterQuery(allCharacters), guildId)
  ).collation({ locale: 'en', strength: 2 }).lean();
  if (!blacklisted) return false;
  await editAlert(interaction, {
    severity: AlertSeverity.WARNING,
    ...t('dialogue.trust.blacklisted', lang, { name, matched: blacklisted.name }),
    lang,
  });
  return true;
}

async function persistTrustedRoster({ existing, name, reason, allCharacters, rosterResult, interaction }) {
  const source = rosterResult?.hasValidRoster ? 'bible' : 'manual';
  if (!existing) {
    await TrustedUser.create({
      name,
      reason,
      allCharacters,
      enrichmentSource: source,
      enrichedAt: new Date(),
      addedByUserId: interaction.user.id,
      addedByTag: interaction.user.tag,
    });
    return;
  }
  await TrustedUser.updateOne(
    { _id: existing._id },
    { $set: {
      ...(reason ? { reason } : {}),
      allCharacters,
      enrichmentSource: source,
      enrichedAt: new Date(),
    } }
  );
}

function buildTrustSuccessFields({ existing, name, reason, allCharacters, rosterResult, interaction, lang }) {
  const fields = [
    { name: `🧬 ${t('dialogue.trust.success.character', lang)}`, value: `[${name}](${rosterUrl(name)})`, inline: true },
    { name: `👤 ${t(`dialogue.trust.success.${existing ? 'refreshedBy' : 'addedBy'}`, lang)}`, value: interaction.user.tag, inline: true },
  ];
  // Two inline fields already split their row evenly, so padding them
  // to thirds would only add a visible gap · see padInlineRow.
  if (fields.length > 3) while (fields.length % 3 !== 0) fields.push({ name: '\u200b', value: '\u200b', inline: true });
  fields.push({
    name: `📝 ${t('dialogue.trust.success.reason', lang)}`,
    value: (reason || existing?.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024),
    inline: false,
  });
  const altsField = renderTrackedAltsField({
    names: allCharacters,
    primaryName: name,
    statMap: statMapFromRosterCharacters(rosterResult?.rosterCharacters || []),
    emptySentinel: `_${t('dialogue.trust.success.onlyCharacter', lang)}_`,
    label: `🧬 ${t('dialogue.trust.success.trackedAlts', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
  if (altsField) fields.push(altsField);
  return fields;
}

function buildTrustSuccessEmbed(args) {
  const { existing, name, lang } = args;
  const actionLabel = t(`dialogue.trust.${existing ? 'actionRefreshed' : 'actionAdded'}`, lang);
  return buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: '',
    color: COLORS.trustedSoft,
    title: `🛡️ ${t('dialogue.trust.success.title', lang, { action: actionLabel, name })}`,
    description: t('dialogue.trust.success.description', lang, { name }),
    fields: buildTrustSuccessFields(args),
    footer: t('dialogue.trust.success.footer', lang),
    lang,
  });
}

async function handleTrustAddition(interaction, name, reason, lang) {
  const existing = await TrustedUser.findOne(buildNameRosterQuery([name]))
    .collation({ locale: 'en', strength: 2 });
  if (existing && existing.name.toLowerCase() !== name.toLowerCase()) {
    await replyExistingTrust(interaction, name, existing, lang);
    return;
  }

  const rosterResult = await buildRosterCharacters(name, { hiddenRosterFallback: true });
  const allCharacters = normalizeRosterNames(
    name,
    rosterResult?.hasValidRoster ? rosterResult.allCharacters : []
  );
  const conflict = await findRosterTrustConflict(existing, allCharacters);
  if (conflict) {
    await replyExistingTrust(interaction, name, conflict, lang);
    return;
  }
  if (!existing && await rejectBlacklistedTrust(interaction, name, allCharacters, lang)) return;

  await persistTrustedRoster({
    existing,
    name,
    reason,
    allCharacters,
    rosterResult,
    interaction,
  });
  await editEmbed(interaction, buildTrustSuccessEmbed({
    existing,
    name,
    reason,
    allCharacters,
    rosterResult,
    interaction,
    lang,
  }));
  console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
}

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
      await handleTrustRemoval(interaction, name, lang);
      return;
    }
    await handleTrustAddition(interaction, name, reason, lang);
  }

  return { handleListTrustCommand };
}
