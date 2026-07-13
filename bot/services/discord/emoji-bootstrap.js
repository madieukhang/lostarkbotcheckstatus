/**
 * services/discord/emoji-bootstrap.js
 *
 * Bot-startup bootstrap that mirrors PNG files in `assets/class-icons/`
 * onto the bot's Discord application emoji slots and populates
 * `CLASS_EMOJI_MAP` (`bot/models/Class.js`) with the resulting
 * `<:name:id>` strings keyed by class display name. Powers the
 * class-icon prefix shown before character names in scan progress /
 * result cards, enrich success card, completion DMs, and the visible
 * roster card.
 *
 * Ported from sister bot RaidManage (`bot/services/emoji-bootstrap.js`)
 * to ESM. This service bootstraps class icons only; RaidManage's separate
 * bot-expression branch is outside its scope.
 *
 * **Content-addressed naming.** Each emoji is uploaded with the name
 * `{fileBaseName}_{md5short}` where md5short is the first 6 chars of
 * the PNG's MD5 hash. On every restart the bootstrap:
 *   - Lists existing application emoji
 *   - For each PNG, computes the expected name from current content
 *   - If an existing emoji matches the expected name -> content unchanged,
 *     reuse the ID
 *   - If an existing emoji exists for the file base but with a DIFFERENT
 *     hash suffix (or no suffix at all - legacy from pre-hash bootstrap)
 *     -> content changed, DELETE the stale emoji + upload new one
 *   - If no existing emoji for the file base -> upload
 *
 * Result: any time a PNG file content changes (new art, color invert,
 * source upgrade) the bot detects it on the next deploy and refreshes
 * Discord's copy automatically without environment changes or a manual script.
 *
 * Failure mode: any error (REST blocked, app emoji slot exhausted, etc.)
 * is logged and swallowed. Bot keeps running with whatever subset of the
 * CLASS_EMOJI_MAP got populated; getClassEmoji falls back to empty
 * string for unmapped classes, so render paths omit unavailable icons.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CLASS_NAMES, CLASS_EMOJI_MAP } from '../../models/Class.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 3 levels up from bot/services/discord/ → repo root, then assets/.
// Pre-refactor file lived at bot/services/ so 2 levels was correct;
// the cef2187 refactor pushed this file one level deeper without
// updating the path, which caused icon discovery to return no files (file walk
// returned empty → bootstrap reused stale Discord emoji slots only).
const CLASS_ICONS_DIR = path.resolve(__dirname, '..', '..', '..', 'assets', 'class-icons');

// Class IDs that share art use one uploaded emoji and map both display names
// to the same ID, reducing application emoji slot usage.
const CLASS_ALIAS_GROUPS = [
  ['soulmaster', 'force_master'], // both = Soulfist
  ['hawkeye', 'hawk_eye'], // both = Sharpshooter
];

function detectMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return 'application/octet-stream';
}

function shortHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').slice(0, 6);
}

function expectedEmojiName(fileBase, buffer) {
  return `${fileBase}_${shortHash(buffer)}`;
}

// Identify an existing application emoji that "belongs" to a given file
// base name, regardless of its hash suffix (or lack thereof). Matches:
//   - The exact base with no underscore suffix (legacy pre-hash format)
//   - The base followed by `_` + hex (current hash-suffix format)
function findExistingForFileBase(existingByName, fileBase) {
  if (existingByName.has(fileBase)) return existingByName.get(fileBase);
  const re = new RegExp(`^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[0-9a-f]{1,12}$`);
  for (const [name, emoji] of existingByName) {
    if (re.test(name)) return emoji;
  }
  return null;
}

async function listAppEmoji({ rest, appId, namespace }) {
  try {
    const list = await rest.get(`/applications/${appId}/emojis`);
    const items = Array.isArray(list?.items)
      ? list.items
      : Array.isArray(list)
        ? list
        : [];
    const byName = new Map();
    for (const e of items) byName.set(e.name, e);
    return byName;
  } catch (err) {
    console.warn(`[${namespace}] failed to list app emojis (continuing without bootstrap):`, err?.message || err);
    return null;
  }
}

/**
 * Bootstrap class emoji: mirrors `assets/class-icons/` -> CLASS_EMOJI_MAP
 * keyed by class display name. Filename = bible class ID (e.g.,
 * `bard.png`); CLASS_NAMES translates to display name.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<{uploaded: number, reused: number, refreshed: number, aliasResolved: number, aliasCleanedUp: number, orphans: number, skipped: number, failed: number, total: number}>}
 */
export async function bootstrapClassEmoji(client) {
  const namespace = 'class-emoji';
  const ZERO = { uploaded: 0, reused: 0, refreshed: 0, aliasResolved: 0, aliasCleanedUp: 0, orphans: 0, skipped: 0, failed: 0, total: 0 };

  if (!fs.existsSync(CLASS_ICONS_DIR)) {
    console.warn(`[${namespace}] icons dir not found at ${CLASS_ICONS_DIR}; skipping bootstrap`);
    return ZERO;
  }

  const allFiles = fs.readdirSync(CLASS_ICONS_DIR)
    .filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f));
  if (allFiles.length === 0) {
    console.warn(`[${namespace}] no image files in ${CLASS_ICONS_DIR}; skipping bootstrap`);
    return ZERO;
  }

  // Dedup by basename. Without this guard, two files like `shy.png` +
  // `shy.webp` would alternate-delete-reupload each boot and churn the
  // emoji ID. Prefer .png > .gif > .jpg > .webp on conflict.
  const extPriority = { png: 0, gif: 1, jpg: 2, jpeg: 2, webp: 3 };
  const filesByBase = new Map();
  for (const f of allFiles) {
    const base = path.parse(f).name;
    const ext = path.parse(f).ext.replace(/^\./, '').toLowerCase();
    const prio = extPriority[ext] ?? 99;
    const current = filesByBase.get(base);
    if (!current || prio < current.prio) filesByBase.set(base, { filename: f, prio });
  }
  const files = [...filesByBase.values()].map((v) => v.filename);

  const appId = client.application?.id || client.user?.id;
  if (!appId) {
    console.warn(`[${namespace}] could not resolve application id; skipping bootstrap`);
    return ZERO;
  }

  const existingByName = await listAppEmoji({ rest: client.rest, appId, namespace });
  if (!existingByName) return ZERO;

  // Pre-compute alias bookkeeping. Aliases share art with the canonical
  // (e.g. soulmaster <-> force_master), so one PNG supplies both emoji IDs.
  const aliasCanonicalByAlias = new Map();
  const aliasFileBases = new Set();
  for (const group of CLASS_ALIAS_GROUPS) {
    const [canonical, ...aliases] = group;
    for (const alias of aliases) {
      aliasCanonicalByAlias.set(alias, canonical);
      aliasFileBases.add(alias);
    }
  }

  // Alias cleanup pass: existing app emoji whose name matches a known
  // non-canonical alias is a structural duplicate of the canonical's
  // art. Auto-delete is safe because aliases are KNOWN duplicates by
  // design.
  let aliasCleanedUp = 0;
  for (const [name, emoji] of [...existingByName.entries()]) {
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, '');
    if (aliasFileBases.has(candidateBase)) {
      try {
        await client.rest.delete(`/applications/${appId}/emojis/${emoji.id}`);
        existingByName.delete(name);
        aliasCleanedUp += 1;
        console.log(`[${namespace}] deleted duplicate alias :${name}: (canonical handles it)`);
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.warn(`[${namespace}] failed to delete duplicate alias :${name}: (${emoji.id}):`, err?.message || err);
      }
    }
  }

  // Sort canonical files ahead of aliases so canonical IDs exist by the
  // time aliases try to resolve.
  const sortedFiles = files.sort((a, b) => {
    const aIsAlias = aliasCanonicalByAlias.has(path.parse(a).name);
    const bIsAlias = aliasCanonicalByAlias.has(path.parse(b).name);
    if (aIsAlias === bIsAlias) return a.localeCompare(b);
    return aIsAlias ? 1 : -1;
  });

  const matchedEmojiIds = new Set();
  const idByFileBase = {};
  const fullNameByFileBase = {};

  let uploaded = 0;
  let reused = 0;
  let refreshed = 0;
  let aliasResolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of sortedFiles) {
    const fileBase = path.parse(filename).name;
    const displayKey = CLASS_NAMES[fileBase] || null;
    if (!displayKey) {
      skipped += 1;
      continue;
    }

    // Alias path: don't upload, point at canonical's already-uploaded ID.
    const canonical = aliasCanonicalByAlias.get(fileBase);
    if (canonical) {
      const canonicalId = idByFileBase[canonical];
      const canonicalName = fullNameByFileBase[canonical];
      if (canonicalId && canonicalName) {
        CLASS_EMOJI_MAP[displayKey] = `<:${canonicalName}:${canonicalId}>`;
        idByFileBase[fileBase] = canonicalId;
        fullNameByFileBase[fileBase] = canonicalName;
        aliasResolved += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const buffer = fs.readFileSync(path.join(CLASS_ICONS_DIR, filename));
    const expectedName = expectedEmojiName(fileBase, buffer);
    const existing = findExistingForFileBase(existingByName, fileBase);

    if (existing && existing.name === expectedName) {
      CLASS_EMOJI_MAP[displayKey] = `<:${existing.name}:${existing.id}>`;
      idByFileBase[fileBase] = existing.id;
      fullNameByFileBase[fileBase] = existing.name;
      matchedEmojiIds.add(existing.id);
      reused += 1;
      continue;
    }

    // Refresh path: existing emoji has the wrong name (different hash, or
    // legacy plain name pre-hash bootstrap). Discord emoji image is
    // immutable - delete the stale one then upload fresh content.
    if (existing) {
      try {
        await client.rest.delete(`/applications/${appId}/emojis/${existing.id}`);
        matchedEmojiIds.add(existing.id);
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.warn(`[${namespace}] failed to delete stale :${existing.name}: (${existing.id}) before refresh:`, err?.message || err);
        failed += 1;
        continue;
      }
    }

    try {
      const mime = detectMime(buffer);
      if (buffer.byteLength > 256 * 1024) {
        console.warn(`[${namespace}] ${filename} is ${buffer.byteLength}B (over 256KB cap); skipping`);
        failed += 1;
        continue;
      }
      const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
      const created = await client.rest.post(`/applications/${appId}/emojis`, {
        body: { name: expectedName, image: dataUri },
      });
      if (!created?.id) {
        console.warn(`[${namespace}] ${filename} upload returned no id; skipping`);
        failed += 1;
        continue;
      }
      CLASS_EMOJI_MAP[displayKey] = `<:${created.name}:${created.id}>`;
      idByFileBase[fileBase] = created.id;
      fullNameByFileBase[fileBase] = created.name;
      matchedEmojiIds.add(created.id);
      if (existing) refreshed += 1;
      else uploaded += 1;
      // Application emoji rate limit: ~50 / 30s. Sleep 250ms between
      // mutations to remain below the limit without excessive startup delay.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed += 1;
      console.warn(`[${namespace}] failed to upload ${filename}:`, err?.message || err);
    }
  }

  // Orphan detection: application emoji whose name parses as a known
  // displayKey but does not match a current PNG. Preserve these entries and
  // report them for manual cleanup because deletion is a separate concern.
  const orphanNames = [];
  for (const [name, emoji] of existingByName) {
    if (matchedEmojiIds.has(emoji.id)) continue;
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, '');
    if (CLASS_NAMES[candidateBase]) orphanNames.push(name);
  }
  if (orphanNames.length > 0) {
    console.warn(`[${namespace}] orphan emoji on application (no matching PNG): ${orphanNames.join(', ')} - delete manually at https://discord.com/developers/applications if no longer wanted`);
  }

  const total = uploaded + reused + refreshed + aliasResolved;
  console.log(`[${namespace}] bootstrap done: uploaded=${uploaded} refreshed=${refreshed} reused=${reused} aliasResolved=${aliasResolved} aliasCleanedUp=${aliasCleanedUp} orphans=${orphanNames.length} skipped=${skipped} failed=${failed} totalActive=${total}`);
  return { uploaded, reused, refreshed, aliasResolved, aliasCleanedUp, orphans: orphanNames.length, skipped, failed, total };
}
