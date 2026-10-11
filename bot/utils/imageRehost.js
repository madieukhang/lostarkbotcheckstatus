/**
 * imageRehost.js
 *
 * Solves the Discord CDN expiry problem for evidence images.
 *
 * Background: as of 2024, Discord CDN attachment URLs include signed expiry
 * tokens (`?ex=...&hm=...`) that invalidate after ~24 hours. Storing the URL
 * directly can produce a 404 after a day or two, violating the evidence
 * retention requirement for the lifetime of the entry.
 *
 * Solution: when a user attaches an image to /la-list add (or similar), the bot
 * immediately re-uploads it to a dedicated "evidence channel" in the owner
 * guild. The bot then stores the rehosted message ID + channel ID instead of
 * the URL. When the image needs to be displayed later, the bot fetches the
 * stored message via the Discord API · Discord re-signs the attachment URL
 * with a fresh expiry on every fetch, so the link is always valid.
 *
 * The evidence channel is configured via /la-remote action:evidencechannel
 * (Senior-only) and stored on the owner guild's GuildConfig.evidenceChannelId.
 * If unset, the bot falls back to legacy direct-URL storage with a warning.
 */

import dns from 'node:dns';
import net from 'node:net';
import { AttachmentBuilder } from 'discord.js';
import config from '../config.js';
import { getGuildConfig } from './scope.js';
import { AlertSeverity, buildNoticeEmbed } from './alertEmbed.js';
import { readBodyWithin } from './responseBody.js';

// Bot uploads are capped at 25 MB; the margin leaves room for the message.
const REHOST_MAX_BYTES = 24 * 1024 * 1024;
// Multiadd rows can name any image host, so a stalled server must not hold
// the confirm flow open.
const REHOST_DOWNLOAD_TIMEOUT_MS = 30_000;
const REHOST_MAX_REDIRECTS = 3;

// Multiadd rows carry member-typed URLs, so the download must not reach the
// bot's own network: loopback, private, link-local, shared (CGNAT),
// benchmark, multicast and reserved ranges. BlockList also matches
// IPv4-mapped IPv6 forms such as ::ffff:127.0.0.1. The IPv6 forms that embed
// or translate to an IPv4 address (IPv4-compatible, NAT64, 6to4, Teredo) and
// deprecated site-local addresses are refused whole.
const NON_PUBLIC_ADDRESSES = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) NON_PUBLIC_ADDRESSES.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC_ADDRESSES.addSubnet(prefix, bits, 'ipv6');

// A refusal can reach a channel through the multiadd summary, so a host that
// does not resolve gets the same text as an internal one; otherwise the reply
// would tell which internal names exist. The detail goes to the log only.
const NOT_PUBLIC = 'not a public address';

// Why a URL may not be downloaded, or '' when its host resolves only to
// public addresses. A name is resolved here and again by fetch, so a DNS
// answer that changes between the two lookups is not covered.
async function refuseNonPublicTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `unsupported protocol ${parsed.protocol}`;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  try {
    addresses = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    console.warn(`[imageRehost] cannot resolve ${host}: ${err.code || err.message}`);
    return NOT_PUBLIC;
  }
  const blocked = addresses.some(({ address, family }) =>
    NON_PUBLIC_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4'));
  if (!blocked) return '';
  console.warn(`[imageRehost] ${host} resolves to a non-public address`);
  return NOT_PUBLIC;
}

// Image types recognised by their first bytes, for a body served without a
// specific content type.
const UNTYPED_CONTENT_TYPE = /^(?:(?:application|binary)\/octet-stream)?\s*(?:;|$)/i;
const IMAGE_SIGNATURES = Object.freeze([
  { ext: 'png', parts: [[0, '89504e470d0a1a0a']] },
  { ext: 'jpg', parts: [[0, 'ffd8ff']] },
  { ext: 'gif', parts: [[0, '47494638']] },
  { ext: 'webp', parts: [[0, '52494646'], [8, '57454250']] },
]);

function imageSignatureExtension(buffer) {
  const matches = ({ parts }) => parts.every(([offset, hex]) =>
    buffer.toString('hex', offset, offset + hex.length / 2) === hex);
  return IMAGE_SIGNATURES.find(matches)?.ext || '';
}

// Follow redirects by hand so every hop's target is checked before the request.
async function fetchPublicUrl(url) {
  const signal = AbortSignal.timeout(REHOST_DOWNLOAD_TIMEOUT_MS);
  let target = url;
  for (let hop = 0; hop <= REHOST_MAX_REDIRECTS; hop++) {
    const refusal = await refuseNonPublicTarget(target);
    if (refusal) return { refusal };
    const response = await fetch(target, { redirect: 'manual', signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return { response };
    await response.body?.cancel().catch(() => {});
    target = new URL(location, target).href;
  }
  return { refusal: `more than ${REHOST_MAX_REDIRECTS} redirects` };
}

const EVIDENCE_LIST_ICON = Object.freeze({
  black: '⛔',
  watch: '⚠️',
  white: '✅',
});

/**
 * Resolve the configured evidence channel ID, or null if not configured.
 * Always reads from the OWNER guild's GuildConfig (not per-guild) · there
 * is one bot-wide evidence channel.
 */
async function getEvidenceChannelId() {
  if (!config.ownerGuildId) return null;
  const ownerConfig = await getGuildConfig(config.ownerGuildId);
  return ownerConfig?.evidenceChannelId || null;
}

/**
 * Download an image URL and re-upload it to the evidence channel for
 * permanent storage. Returns metadata for the rehosted message. A URL whose
 * host (or any redirect target) resolves to a non-public address, or whose
 * body is not an image, is refused and nothing is uploaded.
 *
 * @param {string} originalUrl - The Discord CDN URL (or any image URL) to rehost
 * @param {Client} client - The Discord.js client (used to fetch evidence channel)
 * @param {Object} [meta] - Optional context for the rehosted message body
 * @param {string} [meta.entryName] - Character name (for evidence message text)
 * @param {string} [meta.addedBy] - Display name of the requester
 * @param {string} [meta.listType] - 'black' / 'white' / 'watch'
 * @param {boolean} [meta.throwOnError] - When true, throws an Error with a
 *   specific message instead of returning null on any failure path. Used by
 *   callers (like /la-remote action:syncimages) that need the actual error
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
    return fail('No evidence channel configured. Use /la-remote action:evidencechannel to set one.');
  }

  // Step 1: Download the original image (URL still valid at this point).
  // Separate try blocks per async op so that a thrown error from fail()
  // inside one try block doesn't get re-caught by an outer catch and
  // double-wrapped into "download fetch threw: download HTTP 404" style
  // nonsense messages.
  let download;
  try {
    download = await fetchPublicUrl(originalUrl);
  } catch (err) {
    return fail(`download fetch threw: ${err.message}`);
  }
  if (download.refusal) return fail(`download refused: ${download.refusal}`);
  const { response } = download;

  if (!response.ok) {
    return fail(`download HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ''}`);
  }

  // Only an image goes into the archive. A body without a specific type is
  // read and kept only when it starts with an image signature; any other
  // type is not read.
  const contentType = response.headers.get('content-type') || '';
  const typedImage = /^image\//i.test(contentType);
  const notAnImage = `download is not an image (${contentType || 'no content type'})`;
  if (!typedImage && !UNTYPED_CONTENT_TYPE.test(contentType)) {
    await response.body?.cancel().catch(() => {});
    return fail(notAnImage);
  }

  let buffer;
  try {
    buffer = await readBodyWithin(response, REHOST_MAX_BYTES);
  } catch (err) {
    return fail(err.code === 'BODY_TOO_LARGE'
      ? 'file too large to rehost (> 24 MB limit)'
      : `download read body failed: ${err.message}`);
  }
  const sniffedExt = typedImage ? '' : imageSignatureExtension(buffer);
  if (!typedImage && !sniffedExt) return fail(notAnImage);

  // Try to extract a sensible filename from the URL path. Failure is
  // non-fatal · falls back to 'evidence' with the sniffed type, or png.
  let filename = `evidence.${sniffedExt || 'png'}`;
  try {
    const urlPath = new URL(originalUrl).pathname;
    const lastSegment = urlPath.split('/').pop() || '';
    if (lastSegment && /\.(png|jpg|jpeg|webp|gif)$/i.test(lastSegment)) {
      filename = lastSegment;
    }
  } catch { /* leave default filename */ }

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

  // Step 3: Send the file with metadata in an embed for the audit trail.
  try {
    const attachment = new AttachmentBuilder(buffer, { name: filename });

    // Audit metadata so a human looking at #evidence-archive can see what each
    // image is for. Mentions remain disabled to avoid archive-channel pings.
    const auditLines = [];
    if (meta.entryName) {
      const icon = EVIDENCE_LIST_ICON[meta.listType] || '📎';
      auditLines.push(`${icon} **${meta.entryName}**`);
    }
    if (meta.addedBy) auditLines.push(`Added by: ${meta.addedBy}`);
    auditLines.push(`<t:${Math.floor(Date.now() / 1000)}:f>`);

    const sentMessage = await channel.send({
      embeds: [buildNoticeEmbed(auditLines.join('\n'), {
        severity: AlertSeverity.INFO,
        titleIcon: '📎',
      })],
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

    // A cached message holds the URL signed when it was cached, which may
    // have expired; only a REST fetch returns a newly signed one. The result
    // stays out of the cache because the next refresh fetches again anyway.
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    const attachment = message.attachments?.first();
    return attachment?.url || null;
  } catch (err) {
    // Message deleted, channel removed, bot lost access · all acceptable
    // failure modes. Caller falls back to legacy URL or shows nothing.
    if (err.code !== 10008 /* Unknown Message */ && err.code !== 10003 /* Unknown Channel */) {
      console.warn(`[imageRehost] Refresh failed for ${channelId}/${messageId}:`, err.message);
    }
    return null;
  }
}

function isDiscordCdnUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith('discordapp.com') || hostname.endsWith('discordapp.net');
  } catch {
    return false;
  }
}

/**
 * Make a stored direct evidence link viewable. A Discord attachment link
 * carries a signature that expires, so it is re-signed through Discord's
 * refresh endpoint and then checked, since a re-signed link can still
 * point at a deleted file. Links on other hosts are returned as stored.
 * @param {string} url - the entry's stored imageUrl
 * @param {Client} client - the bot client; its token signs the request
 * @returns {Promise<{url: string, error: string}>} url is '' when Discord
 *   no longer serves the file, and error then says what Discord answered
 */
export async function refreshLegacyImageUrl(url, client) {
  if (!isDiscordCdnUrl(url)) return { url, error: '' };

  const response = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${client.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attachment_urls: [url] }),
  });
  if (!response.ok) return { url: '', error: `refresh API returned ${response.status}` };

  const refreshed = (await response.json())?.refreshed_urls?.[0]?.refreshed;
  if (!refreshed) return { url: '', error: 'refresh returned no URL (file likely deleted)' };

  // Discord re-signs links to ephemeral attachments it has already deleted,
  // so only a request for the file itself shows whether it is still there.
  const file = await fetch(refreshed, { method: 'HEAD' });
  return file.ok ? { url: refreshed, error: '' } : { url: '', error: `file returned ${file.status}` };
}

/**
 * Whether an entry's evidence is only a stored link that was never copied
 * into the evidence archive.
 * @param {object} entry - a list entry
 * @returns {boolean}
 */
export function isLegacyEvidence(entry) {
  return !entry.imageMessageId && Boolean(entry.imageUrl);
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

  // Path 1: rehosted image · fetch fresh URL
  if (entry.imageMessageId && entry.imageChannelId) {
    const fresh = await refreshImageUrl(entry.imageMessageId, entry.imageChannelId, client);
    if (fresh) return fresh;
    // Refresh failed (message deleted etc.) · fall through to legacy
  }

  // Path 2: legacy direct URL · re-signed when it is a Discord link. When
  // Discord cannot be reached, the stored link is still worth a try.
  if (!entry.imageUrl) return '';
  try {
    return (await refreshLegacyImageUrl(entry.imageUrl, client)).url;
  } catch (err) {
    console.warn('[imageRehost] Legacy link refresh failed:', err.message);
    return entry.imageUrl;
  }
}
