import { EmbedBuilder } from 'discord.js';

/**
 * Artist voice tokens shared by user-facing LoaLogs cards.
 *
 * The author line is deliberately quiet: it gives every alert a consistent
 * speaker without adding a catchphrase to each error. Callers keep ownership
 * of operational footers, while cards without one receive a short signature.
 */

export const ARTIST_AUTHOR_NAME = 'Artist · LoaLogs';
export const ARTIST_DEFAULT_FOOTER = 'Artist left this little note with LoaLogs~';

export function createArtistEmbed() {
  return decorateArtistEmbed(new EmbedBuilder());
}

/**
 * Add the common Artist identity to an EmbedBuilder without overwriting
 * caller-provided author/footer metadata.
 * @param {import('discord.js').EmbedBuilder} embed
 * @param {{ defaultFooter?: boolean }} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function decorateArtistEmbed(embed, { defaultFooter = true } = {}) {
  if (!embed?.data?.author) {
    embed.setAuthor({ name: ARTIST_AUTHOR_NAME });
  }
  if (defaultFooter && !embed?.data?.footer) {
    embed.setFooter({ text: ARTIST_DEFAULT_FOOTER });
  }
  return embed;
}
