/**
 * handlers/meta/languageSwitch.js
 * /la-language per-user locale switcher · ephemeral two-step flow.
 * Step 1 renders an embed showing the user's current locale + a
 * SUPPORTED_LANGUAGES dropdown. Step 2 (customId
 * `la-language-switch:select`) persists the new code to UserPreference,
 * invalidates the in-process cache, and replies in the NEW language so
 * the user visually confirms the switch took effect.
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import { connectDB } from '../../db.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';
import UserPreference from '../../models/UserPreference.js';
import {
  getSupportedLanguages,
  getUserLanguage,
  setUserLanguage,
  t,
} from '../../services/i18n/index.js';
import {
  deferEphemeralReply,
  deferUpdate,
  editEmbed,
} from '../../utils/interactionReplies.js';
import { COLORS } from '../../utils/ui.js';

export const LANGUAGE_SWITCH_SELECT_CUSTOM_ID = 'la-language-switch:select';

export function buildLanguageEmbed(lang) {
  const supported = getSupportedLanguages();
  const current = supported.find((entry) => entry.code === lang) || supported[0];

  return createArtistEmbed()
    .setColor(COLORS.info)
    .setTitle(t('languageSwitch.title', lang))
    .setDescription(
      `${t('languageSwitch.description', lang)}\n\n` +
        t('languageSwitch.currentLine', lang, {
          flag: current.flag,
          label: current.label,
        })
    )
    .setFooter({ text: t('languageSwitch.footer', lang) });
}

export function buildLanguageDropdown(lang) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(LANGUAGE_SWITCH_SELECT_CUSTOM_ID)
    .setPlaceholder(t('languageSwitch.placeholder', lang))
    .addOptions(
      getSupportedLanguages().map((entry) => ({
        label: t(`languageSwitch.options.${entry.code}`, lang),
        value: entry.code,
        emoji: entry.flag,
        default: entry.code === lang,
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

export async function handleLanguageSwitchCommand(interaction) {
  await deferEphemeralReply(interaction);
  await connectDB();
  const lang = await getUserLanguage(interaction.user.id, {
    UserPreferenceModel: UserPreference,
  });

  await editEmbed(interaction, buildLanguageEmbed(lang), {
    components: [buildLanguageDropdown(lang)],
  });
}

export async function handleLanguageSwitchSelect(interaction) {
  await deferUpdate(interaction);
  await connectDB();
  const requested = interaction.values?.[0];
  const previous = await getUserLanguage(interaction.user.id, {
    UserPreferenceModel: UserPreference,
  });
  const next = await setUserLanguage(interaction.user.id, requested, {
    UserPreferenceModel: UserPreference,
    user: interaction.user,
  });

  const supported = getSupportedLanguages();
  const target = supported.find((entry) => entry.code === next) || supported[0];
  const unchanged = next === previous;

  const embed = createArtistEmbed()
    .setColor(unchanged ? COLORS.info : COLORS.success)
    .setTitle(t(unchanged ? 'languageSwitch.unchangedTitle' : 'languageSwitch.successTitle', next))
    .setDescription(
      t(
        unchanged ? 'languageSwitch.unchangedDescription' : 'languageSwitch.successDescription',
        next,
        {
          flag: target.flag,
          label: target.label,
        }
      )
    )
    .setFooter({ text: t('languageSwitch.footer', next) });

  await editEmbed(interaction, embed, {
    components: [buildLanguageDropdown(next)],
  });
}
