import { buildAlertEmbed } from './alertEmbed.js';

function toEmbedArray(embedOrEmbeds) {
  return Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds];
}

function withEphemeral(payload, ephemeral) {
  if (ephemeral === undefined) return payload;
  return { ...payload, ephemeral };
}

export function replyEmbed(interaction, embedOrEmbeds, { ephemeral = true, ...extras } = {}) {
  return interaction.reply(withEphemeral({
    embeds: toEmbedArray(embedOrEmbeds),
    ...extras,
  }, ephemeral));
}

export function replyContent(interaction, content, { ephemeral = true, ...extras } = {}) {
  return interaction.reply(withEphemeral({
    content,
    ...extras,
  }, ephemeral));
}

export function editEmbed(interaction, embedOrEmbeds, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: toEmbedArray(embedOrEmbeds),
  });
}

export function editContent(interaction, content, extras = {}) {
  return interaction.editReply({
    content,
    ...extras,
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

export function deferReply(interaction, { ephemeral } = {}) {
  if (ephemeral === undefined) return interaction.deferReply();
  return interaction.deferReply({ ephemeral });
}

export function deferEphemeralReply(interaction) {
  return deferReply(interaction, { ephemeral: true });
}

export function replyAlert(interaction, alertOptions, extras = {}) {
  return replyEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

export function editAlert(interaction, alertOptions, extras = {}) {
  return editEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

export function updateAlert(interaction, alertOptions, extras = {}) {
  return updateEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}
