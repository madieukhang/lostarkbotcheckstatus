/**
 * handlers/meta/help.js
 * /la-help command + drill-down dropdown. Overview embed appends
 * owner-only sections only when invoked inside the owner guild
 * (`config.ownerGuildId`) so admin commands stay out of public help.
 * All copy is locale-aware via the i18n `t()` helper; sections live
 * in locales/<lang>.js under the `help.*` namespace.
 */

import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import config from '../../config.js';
import { connectDB } from '../../db.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t, resolveLocale } from '../../services/i18n/index.js';
import { replyEmbed, updateEmbed } from '../../utils/interactionReplies.js';
import { COLORS } from '../../utils/ui.js';

function pickLang(value) {
  return resolveLocale(value);
}

function isOwnerGuildInteraction(interaction) {
  return interaction.guild?.id === config.ownerGuildId;
}

function toLines(value) {
  return Array.isArray(value) ? value : [value].filter(Boolean);
}

function fieldValue(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

// One field per command family (locale `help.overview.groups`) instead of
// the old single description wall. Discord's 1024-char field cap is the
// per-group budget guard; groups are sized in the locale files so the
// longest (Lists, vi) stays well under it.
function buildOverviewEmbed(lang, isOwnerGuild) {
  const groups = [...t('help.overview.groups', lang)];
  if (isOwnerGuild) {
    groups.push(t('help.overview.ownerGroup', lang));
  }

  return new EmbedBuilder()
    .setTitle(t('help.overview.title', lang))
    .setDescription(String(t('help.overview.intro', lang)).slice(0, 4096))
    .setColor(COLORS.info)
    .addFields(
      groups.map((group) => ({
        name: group.name,
        value: toLines(group.lines).join('\n').slice(0, 1024),
        inline: false,
      }))
    )
    .setFooter({ text: t('help.overview.footer', lang) });
}

function buildDetailEmbed(sectionKey, lang) {
  const section = t(`help.sections.${sectionKey}`, lang);
  const embed = new EmbedBuilder()
    .setTitle(section.title)
    .setDescription(section.description)
    .setColor(COLORS.info)
    .setFooter({ text: section.footer });

  embed.addFields(
    section.fields.map((field) => ({
      name: field.name,
      value: fieldValue(field.value).slice(0, 1024),
      inline: false,
    }))
  );
  return embed;
}

function buildSectionEmbed(sectionKey, lang, isOwnerGuild) {
  if (sectionKey === 'multiadd') return buildDetailEmbed('multiadd', lang);
  if (sectionKey === 'syncimages' && isOwnerGuild) return buildDetailEmbed('syncimages', lang);
  return buildOverviewEmbed(lang, isOwnerGuild);
}

function buildDropdownOption(key, lang) {
  const option = t(`help.dropdown.${key}`, lang);
  return {
    label: option.label,
    value: key,
    description: option.description,
    emoji: option.emoji,
  };
}

function buildHelpDropdown(lang, isOwnerGuild) {
  const options = [
    buildDropdownOption('overview', lang),
    buildDropdownOption('multiadd', lang),
  ];

  if (isOwnerGuild) {
    options.push(buildDropdownOption('syncimages', lang));
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`la-help:select:${lang}`)
    .setPlaceholder(t('help.dropdown.placeholder', lang))
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

async function resolveHelpLanguage(interaction) {
  const requested = interaction.options.getString('lang');
  if (requested) return pickLang(requested);

  await connectDB();
  return getUserLanguage(interaction.user.id, {
    UserPreferenceModel: UserPreference,
  });
}

export async function handleHelpCommand(interaction) {
  const lang = await resolveHelpLanguage(interaction);
  const isOwnerGuild = isOwnerGuildInteraction(interaction);

  await replyEmbed(interaction, buildOverviewEmbed(lang, isOwnerGuild), {
    components: [buildHelpDropdown(lang, isOwnerGuild)],
  });
}

export async function handleHelpSelect(interaction) {
  const lang = pickLang(interaction.customId.split(':')[2]);
  const sectionKey = interaction.values?.[0];
  const isOwnerGuild = isOwnerGuildInteraction(interaction);

  await updateEmbed(interaction, buildSectionEmbed(sectionKey, lang, isOwnerGuild), {
    components: [buildHelpDropdown(lang, isOwnerGuild)],
  });
}
