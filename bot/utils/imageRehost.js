/**
 * imageRehost.js
 *
 * Solves the Discord CDN expiry problem for evidence images.
 *
 * Background: as of 2024, Discord CDN attachment URLs include signed expiry
 * tokens (`?ex=...&hm=...`) that invalidate after ~24 hours. Storing the URL
 * directly means the image silently 404s after a day or two — which is bad
 * for evidence data that's supposed to live as long as the entry does.
 *
 * Solution: when a user attaches an image to /list add (or similar), the bot
 * immediately re-uploads it to a dedicated "evidence channel" in the owner
 * guild. The bot then stores the rehosted message ID + channel ID instead of
 * the URL. When the image needs to be displayed later, the bot fetches the
 * stored message via the Discord API — Discord re-signs the attachment URL
 * with a fresh expiry on every fetch, so the link is always valid.
 *
 * The evidence channel is configured via /laremote action:evidencechannel
 * (Senior-only) and stored on the owner guild's GuildConfig.evidenceChannelId.
 * If unset, the bot falls back to legacy direct-URL storage with a warning.
 */

import { AttachmentBuilder } from 'discord.js';
import config from '../../config.js';
import { getGuildConfig } from './scope.js';

/**
 * Resolve the configured evidence channel ID, or null if not configured.
 * Always reads from the OWNER guild's GuildConfig (not per-guild) — there
 * is one bot-wide evidence channel.
 */
export async function getEvidenceChannelId() {
  if (!config.ownerGuildId) return null;
  const ownerConfig = await getGuildConfig(config.ownerGuildId);
  return ownerConfig?.evidenceChannelId || null;
}

/**
 * Download an image URL and re-upload it to the evidence channel for
 * permanent storage. Returns metadata for the rehosted message.
 *
 * @param {string} originalUrl - The Discord CDN URL (or any image URL) to rehost
 * @param {Client} client - The Discord.js client (used to fetch evidence channel)
 * @param {Object} [meta] - Optional context for the rehosted message body
 * @param {string} [meta.entryName] - Character name (for evidence message text)
 * @param {string} [meta.addedBy] - Display name of the requester
 * @param {string} [meta.listType] - 'black' / 'white' / 'watch'
 * @param {boolean} [meta.throwOnError] - When true, throws an Error with a
 *   specific message instead of returning null on any failure path. Used by
 *   callers (like /laremote action:syncimages) that need the actual error
 *   text in their reporting. Default behavior (false) preserves backward
 *   compatibility with the original null-on-failure contract.
 * @returns {Promise<{ messageId: string, channelId: string, freshUrl: string } | null>}
 *   Returns the rehost metadata on success, or null on any failure (caller
 *   should fall back to storing the original URL as legacy). When
 *   `meta.throwOnError === true`, throws on failure instead of returning null.
 */
export async function rehostImage(originalUrl, client, meta = {}) {
  const throwOnError = meta.throwOnError === true;
  // Local helper: choose between throw and return-null based on the option,
  // and always log to console for Railway log forensics.
  const fail = (msg) => {
    console.warn(`[imageRehost] ${msg}`);
    if (throwOnError) throw new Error(msg);
    return null;
  };

  if (!originalUrl) return fail('originalUrl is empty');

  // Resolve evidence channel ID from owner guild's GuildConfig
  const channelId = await getEvidenceChannelId();
  if (!channelId) {
    return fail('No evidence channel configured. Use /laremote action:evidencechannel to set one.');
  }

  // Step 1: Download the original image (URL still valid at this point)
  let buffer;
  let filename = 'evidence.png';
  try {
    const response = await fetch(originalUrl);
    if (!response.ok) {
      return fail(`download HTTP ${response.status} (${response.statusText || 'no statusText'})`);
    }
    buffer = Buffer.from(await response.arrayBuffer());

    // Try to extract a sensible filename from the URL path
    try {
      const urlPath = new URL(originalUrl).pathname;
      const lastSegment = urlPath.split('/').pop() || '';
      if (lastSegment && /\.(png|jpg|jpeg|webp|gif)$/i.test(lastSegment)) {
        filename = lastSegment;
      }
    } catch { /* leave default filename */ }
  } catch (err) {
    return fail(`download fetch threw: ${err.message}`);
  }

  // Sanity check size — Discord attachments max 25 MB for bots without nitro
  if (buffer.length > 24 * 1024 * 1024) {
    return fail(`file too large to rehost (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 24 MB limit)`);
  }

  // Step 2: Upload to the evidence channel
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    return fail(`cannot fetch evidence channel ${channelId}: ${err.message}`);
  }

  if (!channel || !channel.isTextBased?.()) {
    return fail(`evidence channel ${channelId} is not a text channel`);
  }

  // Step 3: Send the file with metadata in the message content for audit trail
  try {
    const attachment = new AttachmentBuilder(buffer, { name: filename });

    // Audit metadata so a human looking at #evidence-archive can see what each
    // image is for. Plain text only — no embed, no mentions, no spam pings.
    const auditLines = [];
    if (meta.entryName) {
      const icon = meta.listType === 'black' ? '⛔'
        : meta.listType === 'white' ? '✅'
        : meta.listType === 'watch' ? '⚠️'
        : '📎';
      auditLines.push(`${icon} **${meta.entryName}**`);
    }
    if (meta.addedBy) auditLines.push(`Added by: ${meta.addedBy}`);
    auditLines.push(`<t:${Math.floor(Date.now() / 1000)}:f>`);

    const sentMessage = await channel.send({
      content: auditLines.join(' · '),
      files: [attachment],
      allowedMentions: { parse: [] }, // suppress all pings
    });

    // Extract the fresh signed URL from the just-sent attachment
    const sentAttachment = sentMessage.attachments?.first();
    const freshUrl = sentAttachment?.url || '';

    return {
      messageId: sentMessage.id,
      channelId: channel.id,
      freshUrl,
    };
  } catch (err) {
    return fail(`channel.send failed: ${err.code ? `[${err.code}] ` : ''}${err.message}`);
  }
}

/**
 * Refresh a stored evidence image URL by re-fetching the message from
 * Discord. Discord re-signs the attachment URL with a fresh expiry on every
 * fetch, so this is the canonical way to get a working URL for an image
 * that was rehosted some time ago.
 *
 * @param {string} messageId
 * @param {string} channelId
 * @param {Client} client
 * @returns {Promise<string|null>} Fresh signed URL or null if message/channel
 *   no longer exists (deleted, channel removed, etc.)
 */
export async function refreshImageUrl(messageId, channelId, client) {
  if (!messageId || !channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) return null;

    const message = await channel.messages.fetch(messageId);
    const attachment = message.attachments?.first();
    return attachment?.url || null;
  } catch (err) {
    // Message deleted, channel removed, bot lost access — all acceptable
    // failure modes. Caller falls back to legacy URL or shows nothing.
    if (err.code !== 10008 /* Unknown Message */ && err.code !== 10003 /* Unknown Channel */) {
      console.warn(`[imageRehost] Refresh failed for ${channelId}/${messageId}:`, err.message);
    }
    return null;
  }
}

/**
 * Resolve the best display URL for an entry's evidence image. Prefers the
 * rehost-aware path (fresh URL from message) and falls back to the legacy
 * direct URL stored in entry.imageUrl. Returns empty string if no image
 * exists or all paths failed.
 *
 * @param {Object} entry - A list entry document (must have imageUrl,
 *   imageMessageId, imageChannelId fields)
 * @param {Client} client
 * @returns {Promise<string>} URL ready for embed.setImage() or empty string
 */
export async function resolveDisplayImageUrl(entry, client) {
  if (!entry) return '';

  // Path 1: rehosted image — fetch fresh URL
  if (entry.imageMessageId && entry.imageChannelId) {
    const fresh = await refreshImageUrl(entry.imageMessageId, entry.imageChannelId, client);
    if (fresh) return fresh;
    // Refresh failed (message deleted etc.) — fall through to legacy
  }

  // Path 2: legacy direct URL — may be expired but try anyway
  return entry.imageUrl || '';
}
