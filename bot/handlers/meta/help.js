import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import config from '../../config.js';
import { connectDB } from '../../db.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t, resolveLocale } from '../../services/i18n/index.js';
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

function buildOverviewLines(lang, isOwnerGuild) {
  const lines = [...toLines(t('help.overview.lines', lang))];
  if (isOwnerGuild) {
    lines.push('', ...toLines(t('help.overview.ownerLines', lang)));
  }
  return lines;
}

function buildOverviewEmbed(lang, isOwnerGuild) {
  return new EmbedBuilder()
    .setTitle(t('help.overview.title', lang))
    .setDescription(buildOverviewLines(lang, isOwnerGuild).join('\n').slice(0, 4096))
    .setColor(COLORS.info)
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

  await interaction.reply({
    embeds: [buildOverviewEmbed(lang, isOwnerGuild)],
    components: [buildHelpDropdown(lang, isOwnerGuild)],
    ephemeral: true,
  });
}

export async function handleHelpSelect(interaction) {
  const lang = pickLang(interaction.customId.split(':')[2]);
  const sectionKey = interaction.values?.[0];
  const isOwnerGuild = isOwnerGuildInteraction(interaction);

  await interaction.update({
    embeds: [buildSectionEmbed(sectionKey, lang, isOwnerGuild)],
    components: [buildHelpDropdown(lang, isOwnerGuild)],
  });
}
