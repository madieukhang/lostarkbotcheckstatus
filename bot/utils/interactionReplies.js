import { MessageFlags } from 'discord.js';

import {
  NoticeKind,
  buildAlertEmbed,
} from './alertEmbed.js';

function toEmbedArray(embedOrEmbeds) {
  return Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds];
}

function withEphemeral(payload, ephemeral) {
  if (!ephemeral) return payload;
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export function replyEmbed(interaction, embedOrEmbeds, { ephemeral = true, ...extras } = {}) {
  return interaction.reply(withEphemeral({
    embeds: toEmbedArray(embedOrEmbeds),
    ...extras,
  }, ephemeral));
}

export function editEmbed(interaction, embedOrEmbeds, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: toEmbedArray(embedOrEmbeds),
  });
}

export function editComponents(interaction, components, extras = {}) {
  return interaction.editReply({
    ...extras,
    components,
  });
}

export function editPayload(interaction, payload) {
  return interaction.editReply(payload);
}

export function updateEmbed(interaction, embedOrEmbeds, extras = {}) {
  return interaction.update({
    ...extras,
    embeds: toEmbedArray(embedOrEmbeds),
  });
}

export function updatePayload(interaction, payload) {
  return interaction.update(payload);
}

export function deferReply(interaction, { ephemeral } = {}) {
  if (!ephemeral) return interaction.deferReply();
  return interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

export function deferEphemeralReply(interaction) {
  return deferReply(interaction, { ephemeral: true });
}

export function deferUpdate(interaction) {
  return interaction.deferUpdate();
}

export function replyAlert(interaction, alertOptions, extras = {}) {
  return replyEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

/** Send a private notice after a component acknowledgement without replacing its card. */
export function followUpAlert(interaction, alertOptions, extras = {}) {
  return interaction.followUp({ flags: MessageFlags.Ephemeral, embeds: [buildAlertEmbed(alertOptions)], ...extras });
}

export function editAlert(interaction, alertOptions, extras = {}) {
  return editEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

export function updateAlert(interaction, alertOptions, extras = {}) {
  return updateEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

/**
 * Answer a deferred interaction with a short alert after its write was saved
 * but the confirmation card could not be shown, so Discord does not report the
 * request as failed. A failure of this reply is logged and swallowed: the
 * write is already done and nothing else can be sent.
 * @param {object} interaction - the deferred interaction
 * @param {object} alertOptions - buildAlertEmbed options; `kind` defaults to
 *   done and `components` to none, which clears any picker left on the message
 * @returns {Promise<void>}
 */
export async function editAlertAfterSavedWrite(interaction, alertOptions) {
  const { components = [], ...options } = alertOptions;
  try {
    await editAlert(interaction, { kind: NoticeKind.DONE, ...options }, { content: null, components });
  } catch (err) {
    console.warn('[interaction] Notice after a saved write failed:', err.message);
  }
}
