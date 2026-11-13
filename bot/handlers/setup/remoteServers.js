/**
 * handlers/setup/remoteServers.js
 * Server picking and leaving for /la-remote: suggestions for the `guild`
 * option, the guilds a leave refuses, and the owner-only leave flow behind a
 * confirmation card. Leaving keeps every stored record of the server.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, DiscordjsErrorCodes } from 'discord.js';

import config from '../../config.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';
import { NoticeKind } from '../../utils/alertEmbed.js';
import { isApplicationOwner } from '../../utils/applicationOwner.js';
import { isSeniorApprover } from '../../utils/approverRoles.js';
import { editAlert, editPayload, updateAlert } from '../../utils/interactionReplies.js';
import { COLORS } from '../../utils/ui.js';
import { t } from '../../services/i18n/index.js';

const SUGGESTION_LIMIT = 25;
const CHOICE_TEXT_MAX = 100;
const CONFIRM_TIMEOUT_MS = 60_000;
const LEAVE_CONFIRM_ID = 'remote_leave_confirm';
const LEAVE_CANCEL_ID = 'remote_leave_cancel';

const LEAVE_REFUSALS = Object.freeze({
  ownerOnly: { kind: NoticeKind.GUARD, key: 'dialogue.remote.leave.ownerOnly' },
  notFound: { kind: NoticeKind.EXPIRED, key: 'dialogue.remote.guildNotFound' },
  protected: { kind: NoticeKind.GUARD, key: 'dialogue.remote.leave.protected' },
});

/**
 * Guilds the bot must stay in: the owner guild, which holds the owner
 * commands and the evidence channel, and every guild that hosts a channel
 * named in the environment. A channel missing from the cache adds nothing.
 * @param {import('discord.js').Client} client - logged-in client
 * @returns {Set<string>} protected guild ids
 */
export function getProtectedGuildIds(client) {
  const channelIds = [config.channelId, ...config.listNotifyChannelIds, ...config.autoCheckChannelIds];
  const channelGuildIds = channelIds.map((id) => client.channels.cache.get(id)?.guildId);
  return new Set([config.ownerGuildId, ...channelGuildIds].filter(Boolean));
}

/**
 * Suggest the servers the bot is in for the `guild` option. Only Seniors get
 * suggestions; the leave action hides the protected guilds.
 * @param {import('discord.js').AutocompleteInteraction} interaction - /la-remote autocomplete
 * @returns {Promise<void>}
 */
export async function handleRemoteGuildAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'guild' || !isSeniorApprover(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }
    const hidden = interaction.options.getString('action') === 'leave'
      ? getProtectedGuildIds(interaction.client)
      : new Set();
    const query = String(focused.value || '').trim().toLowerCase();
    const choices = [...interaction.client.guilds.cache.values()]
      .filter((guild) => !hidden.has(guild.id))
      .filter((guild) => guild.name.toLowerCase().includes(query) || guild.id.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SUGGESTION_LIMIT)
      .map((guild) => ({ name: `${guild.name} · ${guild.id}`.slice(0, CHOICE_TEXT_MAX), value: guild.id }));
    await interaction.respond(choices);
  } catch (err) {
    console.warn('[la-remote] Server suggestions failed:', err?.message || err);
    await interaction.respond([]).catch(() => {});
  }
}

// Checked before the card and again on the click, since the owner, the
// guild list and the protected set can change while the card waits.
async function findLeaveRefusal(interaction, guildId, isOwner) {
  const { client } = interaction;
  if (!(await isOwner(client, interaction.user.id))) return 'ownerOnly';
  if (!client.guilds.cache.has(guildId)) return 'notFound';
  if (getProtectedGuildIds(client).has(guildId)) return 'protected';
  return null;
}

function leaveRefusalAlert(refusal, guildId, lang) {
  const { kind, key } = LEAVE_REFUSALS[refusal];
  return { kind, ...t(key, lang, { guild: guildId }) };
}

function buildLeaveConfirmCard(guild, lang) {
  const embed = createArtistEmbed()
    .setTitle(`⚠️ ${t('dialogue.remote.leave.confirm.title', lang)}`)
    .setDescription(t('dialogue.remote.leave.confirm.description', lang, { guild: guild.name }))
    .addFields(
      { name: t('dialogue.remote.fields.server', lang), value: `**${guild.name}**\n\`${guild.id}\``, inline: true },
      { name: t('dialogue.remote.leave.fields.members', lang), value: String(guild.memberCount ?? '?'), inline: true },
      { name: t('dialogue.remote.leave.fields.joined', lang), value: `<t:${Math.floor(guild.joinedTimestamp / 1000)}:D>`, inline: true },
    )
    .setColor(COLORS.warning);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(LEAVE_CONFIRM_ID).setLabel(t('dialogue.remote.leave.buttons.confirm', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(LEAVE_CANCEL_ID).setLabel(t('dialogue.remote.leave.buttons.cancel', lang)).setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

async function leaveGuild(interaction, guildId, lang, isOwner) {
  const refusal = await findLeaveRefusal(interaction, guildId, isOwner);
  if (refusal) {
    await editAlert(interaction, leaveRefusalAlert(refusal, guildId, lang), { components: [] });
    return;
  }
  const guild = interaction.client.guilds.cache.get(guildId);
  const label = `${guild.name} (${guild.id})`;
  try {
    await guild.leave();
  } catch (err) {
    console.error(`[la-remote] leave ${label} failed:`, err?.message || err);
    await editAlert(interaction, {
      kind: NoticeKind.FAILURE,
      ...t('dialogue.remote.leave.failed', lang, { guild: label }),
    }, { components: [] });
    return;
  }
  console.log(`[la-remote] left ${label} by ${interaction.user.tag}`);
  await editAlert(interaction, {
    kind: NoticeKind.DONE,
    ...t('dialogue.remote.leave.done', lang, { guild: label }),
  }, { components: [] });
}

/**
 * Remove the bot from one server after the application owner confirms.
 * The deferred reply shows the card; a refusal, a cancel or the 60 s limit
 * ends without leaving.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - deferred /la-remote interaction
 * @param {string} guildId - server to leave
 * @param {string} lang - caller's language
 * @param {{ isOwner?: (client: object, userId: string) => Promise<boolean> }} [deps] - owner check override for tests
 * @returns {Promise<void>}
 */
export async function handleLeaveAction(interaction, guildId, lang, { isOwner = isApplicationOwner } = {}) {
  const refusal = await findLeaveRefusal(interaction, guildId, isOwner);
  if (refusal) {
    await editAlert(interaction, leaveRefusalAlert(refusal, guildId, lang));
    return;
  }
  const guild = interaction.client.guilds.cache.get(guildId);
  const message = await editPayload(interaction, buildLeaveConfirmCard(guild, lang));
  let button;
  try {
    button = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (candidate) => candidate.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch (err) {
    if (err?.code !== DiscordjsErrorCodes.InteractionCollectorError) throw err;
    await editAlert(interaction, { kind: NoticeKind.EXPIRED, ...t('dialogue.remote.leave.expired', lang) }, { components: [] });
    return;
  }
  if (button.customId !== LEAVE_CONFIRM_ID) {
    await updateAlert(button, { kind: NoticeKind.DONE, ...t('dialogue.remote.leave.cancelled', lang) }, { components: [] });
    return;
  }
  await button.deferUpdate();
  await leaveGuild(interaction, guildId, lang, isOwner);
}
