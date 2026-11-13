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
import { cutChoiceText, escapeEmbedText } from '../../utils/discordText.js';
import { editAlert, editPayload, updateAlert } from '../../utils/interactionReplies.js';
import { COLORS } from '../../utils/ui.js';
import { t } from '../../services/i18n/index.js';

const SUGGESTION_LIMIT = 25;
const CONFIRM_TIMEOUT_MS = 60_000;
const LEAVE_CONFIRM_ID = 'remote_leave_confirm';
const LEAVE_CANCEL_ID = 'remote_leave_cancel';

// Checked in order before the card and again on the click, since the guild
// list and the protected set can change while the card waits. The owner is
// read from the cached application, so an ownership transfer shows after a
// restart.
const LEAVE_RULES = Object.freeze([
  {
    refusal: { kind: NoticeKind.GUARD, key: 'dialogue.remote.leave.ownerOnly' },
    refuses: async ({ client, userId }) => !(await isApplicationOwner(client, userId)),
  },
  {
    refusal: { kind: NoticeKind.EXPIRED, key: 'dialogue.remote.guildNotFound' },
    refuses: ({ client, guildId }) => !client.guilds.cache.has(guildId),
  },
  {
    refusal: { kind: NoticeKind.GUARD, key: 'dialogue.remote.leave.protected' },
    refuses: ({ client, guildId }) => getProtectedGuildIds(client).has(guildId),
  },
]);

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

// An unavailable guild (a Discord outage at ready) carries only its id, with
// no name and no join date, so every label falls back to the id.
function guildName(guild) {
  return guild.name ?? guild.id;
}

function joinedLabel(guild) {
  return Number.isFinite(guild.joinedTimestamp) ? `<t:${Math.floor(guild.joinedTimestamp / 1000)}:D>` : '?';
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
      .filter((guild) => guildName(guild).toLowerCase().includes(query) || guild.id.includes(query))
      .sort((a, b) => guildName(a).localeCompare(guildName(b)))
      .slice(0, SUGGESTION_LIMIT)
      .map((guild) => ({
        name: cutChoiceText(guild.name ? `${guild.name} · ${guild.id}` : guild.id),
        value: guild.id,
      }));
    await interaction.respond(choices);
  } catch (err) {
    console.warn('[la-remote] Server suggestions failed:', err?.message || err);
    await interaction.respond([]).catch(() => {});
  }
}

// The first LEAVE_RULES refusal for this caller and guild, or null.
async function findLeaveRefusal(interaction, guildId) {
  const context = { client: interaction.client, userId: interaction.user.id, guildId };
  for (const rule of LEAVE_RULES) {
    if (await rule.refuses(context)) return rule.refusal;
  }
  return null;
}

function leaveRefusalAlert({ kind, key }, guildId, lang) {
  return { kind, ...t(key, lang, { guild: guildId }) };
}

// The private card asking the owner to confirm, with Leave and Cancel. The
// server name is chosen by strangers, so it is escaped before it is shown.
function buildLeaveConfirmCard(guild, lang) {
  const shownName = escapeEmbedText(guildName(guild));
  const embed = createArtistEmbed()
    .setTitle(`⚠️ ${t('dialogue.remote.leave.confirm.title', lang)}`)
    .setDescription(t('dialogue.remote.leave.confirm.description', lang, { guild: shownName }))
    .addFields(
      { name: t('dialogue.remote.fields.server', lang), value: `**${shownName}**\n\`${guild.id}\``, inline: true },
      { name: t('dialogue.remote.leave.fields.members', lang), value: String(guild.memberCount ?? '?'), inline: true },
      { name: t('dialogue.remote.leave.fields.joined', lang), value: joinedLabel(guild), inline: true },
    )
    .setColor(COLORS.warning);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(LEAVE_CONFIRM_ID).setLabel(t('dialogue.remote.leave.buttons.confirm', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(LEAVE_CANCEL_ID).setLabel(t('dialogue.remote.leave.buttons.cancel', lang)).setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons] };
}

// The confirmed click: re-check, then the one guild.leave() call, logged.
// The original reply carries the outcome, since the button was deferred.
async function leaveGuild(interaction, guildId, lang) {
  const refusal = await findLeaveRefusal(interaction, guildId);
  if (refusal) {
    await editAlert(interaction, leaveRefusalAlert(refusal, guildId, lang), { components: [] });
    return;
  }
  const guild = interaction.client.guilds.cache.get(guildId);
  const logLabel = `${guildName(guild)} (${guild.id})`;
  const shownLabel = `${escapeEmbedText(guildName(guild))} (${guild.id})`;
  try {
    await guild.leave();
  } catch (err) {
    console.error(`[la-remote] leave ${logLabel} failed:`, err?.message || err);
    await editAlert(interaction, {
      kind: NoticeKind.FAILURE,
      ...t('dialogue.remote.leave.failed', lang, { guild: shownLabel }),
    }, { components: [] });
    return;
  }
  console.log(`[la-remote] left ${logLabel} by ${interaction.user.tag}`);
  await editAlert(interaction, {
    kind: NoticeKind.DONE,
    ...t('dialogue.remote.leave.done', lang, { guild: shownLabel }),
  }, { components: [] });
}

/**
 * Remove the bot from one server after the application owner confirms.
 * The deferred reply shows the card; a refusal, a cancel or the 60 s limit
 * ends without leaving.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - deferred /la-remote interaction
 * @param {string} guildId - server to leave
 * @param {string} lang - caller's language
 * @returns {Promise<void>}
 */
export async function handleLeaveAction(interaction, guildId, lang) {
  const refusal = await findLeaveRefusal(interaction, guildId);
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
  await leaveGuild(interaction, guildId, lang);
}
