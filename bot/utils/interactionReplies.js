import {
  AlertSeverity,
  buildAlertEmbed,
  buildNoticeEmbed,
} from './alertEmbed.js';

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
  if (ephemeral === undefined) return interaction.deferReply();
  return interaction.deferReply({ ephemeral });
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

export function editAlert(interaction, alertOptions, extras = {}) {
  return editEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

export function updateAlert(interaction, alertOptions, extras = {}) {
  return updateEmbed(interaction, buildAlertEmbed(alertOptions), extras);
}

function resolveNotice(content, options = {}) {
  const {
    severity = AlertSeverity.INFO,
    lang = 'en',
    title,
    titleIcon,
    color,
    footer,
    timestamp,
    ...extras
  } = options;
  return {
    embed: buildNoticeEmbed(content, {
      severity,
      lang,
      title,
      titleIcon,
      color,
      footer,
      timestamp,
    }),
    extras,
  };
}

export function replyNotice(interaction, content, { ephemeral = true, ...options } = {}) {
  const { embed, extras } = resolveNotice(content, options);
  return replyEmbed(interaction, embed, { ephemeral, ...extras });
}

export function editNotice(interaction, content, options = {}) {
  const { embed, extras } = resolveNotice(content, options);
  return editEmbed(interaction, embed, { content: null, ...extras });
}

export function updateNotice(interaction, content, options = {}) {
  const { embed, extras } = resolveNotice(content, options);
  return updateEmbed(interaction, embed, { content: null, ...extras });
}
