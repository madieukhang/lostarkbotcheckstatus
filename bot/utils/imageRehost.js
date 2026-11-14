/**
 * imageRehost.js
 *
 * Keeps evidence images readable for the lifetime of a list entry.
 *
 * Discord CDN attachment URLs include signed expiry tokens (`?ex=...&hm=...`)
 * that invalidate after ~24 hours, so an entry does not store one. When a user
 * attaches an image to /la-list add (or similar), the bot re-uploads it to a
 * dedicated "evidence channel" in the owner guild and stores that message ID +
 * channel ID; the same bytes also go to MongoDB (utils/evidenceStore.js, keyed
 * by SHA-256). To display the image, the bot fetches the stored message via
 * the Discord API, which re-signs the attachment URL on every fetch.
 *
 * Two layers: when Discord reports the archive message gone, the display path
 * serves the database copy, re-posting it to the evidence channel and pointing
 * the entries at the new message. An entry written straight to the database
 * (only imageSha256 set) is archived the same way the first time it is shown.
 * copyArchiveToDatabase backfills the database copy for older archive messages.
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
import { AlertSeverity, buildAlertEmbed } from './alertEmbed.js';
import { readBodyWithin } from './responseBody.js';
import {
  EVIDENCE_COPY_MAX_BYTES,
  findEvidenceImage,
  isKnownArchiveMessage,
  recordArchiveCopy,
  repointEntries,
  storeEvidenceImage,
} from './evidenceStore.js';

// Bot uploads are capped at 25 MB; the margin leaves room for the message.
const REHOST_MAX_BYTES = 24 * 1024 * 1024;
// Multiadd rows can name any image host, so a stalled server must not hold
// the confirm flow open.
const REHOST_DOWNLOAD_TIMEOUT_MS = 30_000;
const REHOST_MAX_REDIRECTS = 3;
// A viewer waits on each of the two small requests that re-sign a stored
// link, so each gets a shorter budget than a download.
const LEGACY_REFRESH_TIMEOUT_MS = REHOST_DOWNLOAD_TIMEOUT_MS / 2;

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
  // "BM" alone is common in text, so a bitmap also needs a known DIB header
  // size: the little-endian uint32 at offset 14.
  ...[12, 40, 52, 56, 64, 108, 124].map((size) => ({
    ext: 'bmp',
    parts: [[0, '424d'], [14, `${size.toString(16).padStart(2, '0')}000000`]],
  })),
  // ISO base media files carry their brand after `ftyp`; only image brands count.
  ...['avif', 'avis', 'heic', 'heix', 'mif1'].map((brand) => ({
    ext: brand.startsWith('avi') ? 'avif' : 'heic',
    parts: [[4, Buffer.from(`ftyp${brand}`).toString('hex')]],
  })),
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

// The last path segment when it names an image file, else the fallback.
function imageFilenameFromUrl(url, fallback) {
  try {
    const lastSegment = new URL(url).pathname.split('/').pop() || '';
    return /\.(png|jpg|jpeg|webp|gif)$/i.test(lastSegment) ? lastSegment : fallback;
  } catch {
    return fallback;
  }
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
 * Whether a broadcast button may open an archive message. Its custom id
 * names the channel and message, so it is trusted only for the evidence
 * channel, or for a message the database knows (one archived while an
 * earlier evidence channel was set).
 * @param {{channelId: string, messageId: string}} ids - from the custom id
 * @param {object} [deps]
 * @param {Function} [deps.getChannelIdFn] - the evidence channel, or null
 * @param {Function} [deps.isKnownFn] - whether the database knows a message id
 * @returns {Promise<boolean>} true when the message may be shown
 */
export async function isEvidenceArchiveMessage(
  { channelId, messageId },
  { getChannelIdFn = getEvidenceChannelId, isKnownFn = isKnownArchiveMessage } = {}
) {
  const evidenceChannelId = await getChannelIdFn();
  if (evidenceChannelId && channelId === evidenceChannelId) return true;
  return isKnownFn(messageId);
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
 * @param {boolean} [meta.pending] - a member's request archives it before any
 *   approval, so the evidence sweep may remove it if nothing keeps it
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

  // Only an image goes into the archive. A body typed as an image or without
  // a specific type is read and kept only when it starts with an image
  // signature; any other type is not read.
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
  const sniffedExt = imageSignatureExtension(buffer);
  if (!sniffedExt) return fail(notAnImage);

  const filename = imageFilenameFromUrl(originalUrl, `evidence.${sniffedExt}`);

  // Steps 2 and 3: upload to the evidence channel, with audit metadata so a
  // human looking at #evidence-archive can see what each image is for.
  const auditLines = [];
  if (meta.entryName) auditLines.push(`${EVIDENCE_LIST_ICON[meta.listType] || '📎'} ${meta.entryName}`);
  if (meta.addedBy) auditLines.push(`Added by: ${meta.addedBy}`);
  const [title, ...details] = auditLines;
  let archived;
  try {
    archived = await postToEvidenceChannel(channelId, { buffer, filename, title, details }, client);
  } catch (err) {
    return fail(err.message);
  }

  // Step 4: the database copy. It is best effort, so the archive result
  // stands even when the store fails.
  await storeEvidenceImage({
    buffer,
    contentType: typedImage ? contentType : `image/${sniffedExt}`,
    filename,
    archive: { messageId: archived.messageId, channelId: archived.channelId },
    pending: meta.pending === true,
  });
  return archived;
}

/**
 * Upload one image to the evidence channel with its audit embed.
 * @param {string} channelId - the evidence channel
 * @param {object} post
 * @param {Buffer} post.buffer - image bytes
 * @param {string} post.filename - attachment name
 * @param {string} [post.title] - first audit line
 * @param {string[]} [post.details] - further audit lines
 * @param {Client} client - the bot client
 * @returns {Promise<{messageId: string, channelId: string, freshUrl: string}>}
 * @throws {Error} when the channel cannot be fetched, is not a text channel,
 *   or refuses the message
 */
async function postToEvidenceChannel(channelId, { buffer, filename, title, details = [] }, client) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    throw new Error(`cannot fetch evidence channel ${channelId}: ${err.message}`);
  }
  if (!channel || !channel.isTextBased?.()) {
    throw new Error(`evidence channel ${channelId} is not a text channel`);
  }

  let sentMessage;
  try {
    // Mentions stay disabled to avoid archive-channel pings. The upload time
    // stays in the description because a title shows <t:...> as raw text.
    sentMessage = await channel.send({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.INFO,
        titleIcon: '📎',
        title,
        description: [...details, `<t:${Math.floor(Date.now() / 1000)}:f>`].join('\n'),
        timestamp: false,
      })],
      files: [new AttachmentBuilder(buffer, { name: filename })],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    throw new Error(`channel.send failed: ${err.code ? `[${err.code}] ` : ''}${err.message}`);
  }

  return {
    messageId: sentMessage.id,
    channelId: channel.id,
    freshUrl: sentMessage.attachments?.first()?.url || '',
  };
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
  return (await probeArchiveImage(messageId, channelId, client)).url || null;
}

/**
 * Copy one archived image into the database, keyed to its archive message.
 * Used by the syncimages backfill for images archived before the database
 * copy existed.
 * @param {string} messageId - evidence-channel message
 * @param {string} channelId - its channel
 * @param {Client} client - the bot client
 * @returns {Promise<{status: 'stored'|'gone'|'failed', error: string}>}
 */
export async function copyArchiveToDatabase(messageId, channelId, client) {
  const archived = await probeArchiveImage(messageId, channelId, client);
  if (!archived.url) {
    return archived.gone
      ? { status: 'gone', error: 'archive message is gone' }
      : { status: 'failed', error: 'archive message could not be read' };
  }

  let response;
  try {
    response = await fetch(archived.url, { signal: AbortSignal.timeout(REHOST_DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return { status: 'failed', error: `download fetch threw: ${err.message}` };
  }
  if (!response.ok) return { status: 'failed', error: `download HTTP ${response.status}` };

  let buffer;
  try {
    buffer = await readBodyWithin(response, EVIDENCE_COPY_MAX_BYTES);
  } catch (err) {
    return {
      status: 'failed',
      error: err.code === 'BODY_TOO_LARGE' ? 'image is over the database copy cap' : `download read body failed: ${err.message}`,
    };
  }

  const sha256 = await storeEvidenceImage({
    buffer,
    contentType: response.headers.get('content-type') || '',
    filename: imageFilenameFromUrl(archived.url, 'evidence.png'),
    archive: { messageId, channelId },
  });
  return sha256 ? { status: 'stored', error: '' } : { status: 'failed', error: 'database copy failed' };
}

// Discord answers that the archive copy no longer exists or can no longer be
// read by the bot: Unknown Channel, Unknown Message, Missing Access.
const ARCHIVE_GONE_CODES = new Set([10003, 10008, 50001]);

/**
 * Fetch an archive message's freshly signed image link, and tell a copy that
 * is gone from a fetch that failed for now. Only a gone copy may be replaced
 * from the database; a timeout, 5xx or 429 is not gone.
 * @param {string} messageId - evidence-channel message
 * @param {string} channelId - its channel
 * @param {Client} client - the bot client
 * @returns {Promise<{url: string, gone: boolean}>} url is '' when no link was
 *   read; gone is true only when Discord says the copy cannot be read again
 */
export async function probeArchiveImage(messageId, channelId, client) {
  if (!messageId || !channelId) return { url: '', gone: false };

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) return { url: '', gone: true };

    // A cached message holds the URL signed when it was cached, which may
    // have expired; only a REST fetch returns a newly signed one. The result
    // stays out of the cache because the next refresh fetches again anyway.
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    const url = message.attachments?.first()?.url || '';
    return { url, gone: !url };
  } catch (err) {
    // A deleted message or channel is an expected outcome and is not logged.
    if (err.code !== 10008 /* Unknown Message */ && err.code !== 10003 /* Unknown Channel */) {
      console.warn(`[imageRehost] Refresh failed for ${channelId}/${messageId}:`, err.message);
    }
    return { url: '', gone: ARCHIVE_GONE_CODES.has(err.code) };
  }
}

function isDiscordCdnUrl(url) {
  try {
    const { hostname } = new URL(url);
    return ['discordapp.com', 'discordapp.net'].some((host) => hostname === host || hostname.endsWith(`.${host}`));
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
 * @throws {Error} when a request fails or Discord does not answer within
 *   LEGACY_REFRESH_TIMEOUT_MS
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
    signal: AbortSignal.timeout(LEGACY_REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) return { url: '', error: `refresh API returned ${response.status}` };

  const refreshed = (await response.json())?.refreshed_urls?.[0]?.refreshed;
  if (!refreshed) return { url: '', error: 'refresh returned no URL (file likely deleted)' };

  // Discord re-signs links to ephemeral attachments it has already deleted,
  // so only a request for the file itself shows whether it is still there.
  const file = await fetch(refreshed, {
    method: 'HEAD',
    signal: AbortSignal.timeout(LEGACY_REFRESH_TIMEOUT_MS),
  });
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
 * Whether an entry has any evidence image: an archive message, a stored
 * direct link, or a database copy not archived yet.
 * @param {object|null} entry - a list entry
 * @returns {boolean}
 */
export function hasEvidence(entry) {
  return Boolean(entry?.imageMessageId || entry?.imageUrl || entry?.imageSha256);
}

// An entry stored straight in the database with no archive message or link.
// An edit to a new image leaves an older imageSha256 in place, so the hash
// counts only when nothing newer is set.
function isDatabaseOnlyEvidence(entry) {
  return !entry.imageMessageId && !entry.imageUrl && Boolean(entry.imageSha256);
}

/**
 * Resolve the best display URL for an entry's evidence image: its archive
 * message, then the database copy when that message is gone (or the entry
 * has only a database copy), then the legacy direct URL. Returns empty
 * string if no image exists or all paths failed.
 *
 * @param {Object} entry - A list entry (imageUrl, imageMessageId,
 *   imageChannelId, imageSha256), or the same fields of a broadcast button
 * @param {Client} client
 * @param {object} [options]
 * @param {boolean} [options.heal=true] - allow a re-post of the database copy
 *   to the evidence channel; off for an image shown once and not kept
 * @returns {Promise<string>} URL ready for embed.setImage() or empty string
 */
export async function resolveDisplayImageUrl(entry, client, { heal = true } = {}) {
  if (!entry) return '';

  // Path 1: the entry's own archive message.
  const goneIds = [];
  if (entry.imageMessageId && entry.imageChannelId) {
    const own = await probeArchiveImage(entry.imageMessageId, entry.imageChannelId, client);
    if (own.url) return own.url;
    if (own.gone) goneIds.push(entry.imageMessageId);
  }

  // Path 2: the database copy, only when Discord said the archive copy is
  // gone or the entry has nothing but the database copy; a failed fetch for
  // now does not heal.
  if (goneIds.length > 0 || isDatabaseOnlyEvidence(entry)) {
    const restored = await restoreFromDatabase(entry, goneIds, client, { heal });
    if (restored) return restored;
  }

  // Path 3: legacy direct URL · re-signed when it is a Discord link. When
  // Discord cannot be reached, the stored link is still worth a try.
  if (!entry.imageUrl) return '';
  try {
    return (await refreshLegacyImageUrl(entry.imageUrl, client)).url;
  } catch (err) {
    console.warn('[imageRehost] Legacy link refresh failed:', err.message);
    return entry.imageUrl;
  }
}

// One re-post per lost image at a time; concurrent viewers share it. The bot
// runs as one process, so an in-process map is enough.
const inFlightRestores = new Map();

async function repointBestEffort(target) {
  try {
    await repointEntries(target);
  } catch (err) {
    console.warn('[imageRehost] Re-pointing entries to the restored copy failed:', err.message);
  }
}

// The newest archive copy of the stored image when it still exists; else,
// with `heal`, a re-post of the stored bytes. Entries on a gone copy (or
// with only the hash) are re-pointed to the copy served.
async function restoreFromDatabase(entry, goneIds, client, { heal }) {
  // A gone message names its own image; the hash is used only by an entry
  // with no message, since an edit can leave an older hash behind.
  const key = goneIds.length > 0 ? { messageId: goneIds[0] } : { sha256: entry.imageSha256 };
  let image;
  try {
    image = await findEvidenceImage(key);
  } catch (err) {
    console.warn('[imageRehost] Database copy lookup failed:', err.message);
    return '';
  }
  if (!image) return '';

  const gone = [...goneIds];
  if (image.archiveMessageId && !gone.includes(image.archiveMessageId)) {
    const newest = await probeArchiveImage(image.archiveMessageId, image.archiveChannelId, client);
    if (newest.url) {
      await repointBestEffort({
        sha256: image._id,
        goneMessageIds: gone,
        messageId: image.archiveMessageId,
        channelId: image.archiveChannelId,
      });
      return newest.url;
    }
    if (!newest.gone) return '';
    gone.push(image.archiveMessageId);
  }
  if (!heal) return '';

  let pending = inFlightRestores.get(image._id);
  if (!pending) {
    pending = repostFromDatabase(image._id, gone, entry, client)
      .finally(() => inFlightRestores.delete(image._id));
    inFlightRestores.set(image._id, pending);
  }
  return pending;
}

// A lean read returns a BSON Binary; value() is exactly the stored bytes.
function storedBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  return typeof data?.value === 'function' ? Buffer.from(data.value()) : null;
}

// A skipped re-post leaves the evidence hidden, so the log names the cause.
function skipRepost(sha256, reason) {
  console.warn(`[imageRehost] Re-post of database copy ${sha256} skipped: ${reason}`);
  return '';
}

async function repostFromDatabase(sha256, goneIds, entry, client) {
  try {
    const channelId = await getEvidenceChannelId();
    if (!channelId) {
      return skipRepost(sha256, config.ownerGuildId ? 'the owner guild has no evidence channel' : 'OWNER_GUILD_ID is not set');
    }
    const image = await findEvidenceImage({ sha256 }, { withData: true });
    const buffer = storedBytes(image?.data);
    if (!buffer) return skipRepost(sha256, 'no stored bytes');
    const archived = await postToEvidenceChannel(channelId, {
      buffer,
      filename: image.filename || 'evidence.png',
      title: 'Restored from database',
      details: entry?.name ? [entry.name] : [],
    }, client);
    // The post already exists, so a failed record still shows it.
    try {
      await recordArchiveCopy(sha256, archived);
    } catch (err) {
      console.warn(`[imageRehost] Recording the restored copy of ${sha256} failed:`, err.message);
    }
    await repointBestEffort({ sha256, goneMessageIds: goneIds, messageId: archived.messageId, channelId: archived.channelId });
    return archived.freshUrl;
  } catch (err) {
    console.warn(`[imageRehost] Re-post of database copy ${sha256} failed:`, err.message);
    return '';
  }
}
