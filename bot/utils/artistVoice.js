import { EmbedBuilder } from 'discord.js';

/**
 * Shared entry point for user-facing LoaLogs cards. Artist is expressed by
 * the localized copy itself; embeds intentionally carry no repeated author
 * badge or signature footer.
 */

export function createArtistEmbed() {
  return decorateArtistEmbed(new EmbedBuilder());
}

/**
 * Preserve the shared construction seam without injecting branding.
 * @param {import('discord.js').EmbedBuilder} embed
 * @returns {import('discord.js').EmbedBuilder}
 */
export function decorateArtistEmbed(embed) {
  return embed;
}
