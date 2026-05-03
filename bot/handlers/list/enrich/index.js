/**
 * /la-list enrich <name>
 *
 * Run a stronghold deep scan against an existing list entry and append
 * the discovered alts to its `allCharacters` array. The entry must
 * already exist (created via `/la-list add` or `/la-list multiadd`); this
 * command does NOT create entries, only enriches them.
 *
 * Why this is a separate command:
 *   - `/la-list add` is on the user-facing fast path and must reply within
 *     Discord's 3s defer budget. Stronghold deep scans take 5-7 minutes
 *     in production with the new cap (300) and concurrency (3).
 *   - Most adds do not need a deep scan: visible-roster characters
 *     return their full alt list directly via the roster scrape.
 *   - The blacklist edge case (target griefed under one alt, has more)
 *     is exactly when an officer wants the option to opt in to a
 *     thorough discovery on demand.
 *
 * Permission gate: officer/senior approvers only. The original entry
 * already passed approval; enrichment just appends mechanically-
 * matched alts (same stronghold name + roster level on bible) to that
 * entry. There is no subjective decision here, so no approval flow.
 *
 * Cooldown: 30 seconds per entry (in-memory). Deep scans burn bible
 * quota; the cooldown prevents an accidental double-click from
 * doubling the request count.
 *
 * Confirm dialog: stronghold matching has rare false positives when
 * two unrelated rosters happen to share both stronghold name and
 * roster level (collision rate observed at ~0% in real scans, but
 * non-zero in principle). The officer reviews the discovered list
 * before commit; cancel discards.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import { getClassName } from '../../../models/Class.js';
import {
  fetchCharacterMeta,
  fetchGuildMembers,
  detectAltsViaStronghold,
} from '../../../services/rosterService.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { isOfficerOrSenior } from '../helpers.js';

const ENRICH_COOLDOWN_MS = 30 * 1000;
const SESSION_TTL_MS = 5 * 60 * 1000;

// In-memory state. Both maps are cleared on bot restart, which is
// acceptable: cooldowns reset and any pending session expires.
const enrichCooldown = new Map(); // normalized name -> Date.now() of last run
const sessions = new Map();        // sessionId -> { callerId, type, entryId, ... }

function newSessionId() {
  return Math.random().toString(36).slice(2, 12);
}

const COLLATION = { locale: 'en', strength: 2 };

const LIST_LABELS = {
  black: { label: 'blacklist', icon: '⛔', color: 0xed4245 },
  white: { label: 'whitelist', icon: '✅', color: 0x57f287 },
  watch: { label: 'watchlist', icon: '👁️', color: 0xfee75c },
};

const MODELS_BY_TYPE = {
  black: Blacklist,
  white: Whitelist,
  watch: Watchlist,
};

async function findEntryByName(name) {
  const black = await Blacklist.findOne({ name }).collation(COLLATION).lean();
  if (black) return { type: 'black', entry: black };
  const white = await Whitelist.findOne({ name }).collation(COLLATION).lean();
  if (white) return { type: 'white', entry: white };
  const watch = await Watchlist.findOne({ name }).collation(COLLATION).lean();
  if (watch) return { type: 'watch', entry: watch };
  return null;
}

export function createEnrichHandlers({ client, services }) {
  // services may grow Phase 3.5 broadcast support later; not used today.
  // eslint-disable-next-line no-unused-vars
  const _services = services;

  async function handleListEnrichCommand(interaction) {
    if (!isOfficerOrSenior(interaction.user.id)) {
      await interaction.reply({
        content: '⛔ Only officers/senior approvers can run `/la-list enrich`.',
        ephemeral: true,
      });
      return;
    }

    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);
    const cap = interaction.options.getInteger('deep_limit') ?? config.strongholdDeepCandidateLimit;

    // In-memory cooldown gate keyed by case-insensitive name.
    const cooldownKey = name.toLowerCase();
    const lastRun = enrichCooldown.get(cooldownKey);
    if (lastRun && Date.now() - lastRun < ENRICH_COOLDOWN_MS) {
      const wait = Math.ceil((ENRICH_COOLDOWN_MS - (Date.now() - lastRun)) / 1000);
      await interaction.reply({
        content: `⏳ Please wait ${wait}s before re-enriching **${name}**.`,
        ephemeral: true,
      });
      return;
    }
    enrichCooldown.set(cooldownKey, Date.now());

    await interaction.deferReply();
    await connectDB();

    const found = await findEntryByName(name);
    if (!found) {
      await interaction.editReply({
        content: `❌ No list entry found for **${name}**. Use \`/la-list add\` to create one first.`,
      });
      return;
    }

    // Up-front bible probe so we can fail fast on no-guild / no-stronghold
    // before paying the multi-minute candidate fan-out.
    const meta = await fetchCharacterMeta(name, {
      allowScraperApi: false,
      fallbackOnRateLimit: false,
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    });
    if (!meta) {
      await interaction.editReply({
        content: `❌ Could not fetch character meta for **${name}** from lostark.bible. Profile may be hidden or the name may be misspelled.`,
      });
      return;
    }
    if (!meta.guildName) {
      await interaction.editReply({
        content: `❌ **${name}** has no guild on bible. Stronghold deep scan requires a guild member list to walk.`,
      });
      return;
    }

    // Surface scan-in-progress to the channel so the officer knows the
    // command is alive during the long fetch fan-out. Single update,
    // no streaming — Discord webhook edits are cheap and Operations
    // already monitor server logs for the per-25 progress lines.
    const guildMembers = await fetchGuildMembers(name, {
      allowScraperApi: false,
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      cacheKey: meta.guildName,
    });
    if (guildMembers.length === 0) {
      await interaction.editReply({
        content: `❌ Could not fetch guild member list for **${name}** without ScraperAPI. Try again later.`,
      });
      return;
    }

    await interaction.editReply({
      content:
        `🔍 Running stronghold deep scan for **${name}** in guild **${meta.guildName}**` +
        ` (${guildMembers.length} guild members, cap ${cap}, concurrency ${config.strongholdDeepConcurrency}, ScraperAPI off). ` +
        `Expect roughly 5-7 minutes; do not click anything.`,
    });

    const result = await detectAltsViaStronghold(name, {
      targetMeta: meta,
      guildMembers,
      candidateLimit: cap,
      useScraperApiForCandidates: false,
      allowScraperApiForTarget: false,
      allowScraperApiForGuild: false,
    });

    if (!result || !Array.isArray(result.alts) || result.alts.length === 0) {
      await interaction.editReply({
        content:
          `🔍 Scan complete for **${name}** in **${meta.guildName}**. ` +
          `No alts matched (scanned ${result?.scannedCandidates ?? 0} candidates, ` +
          `${result?.failedCandidates ?? 0} failed).`,
      });
      return;
    }

    // Diff against entry.allCharacters to surface only NEW alts. Names
    // are stored case-sensitive in the DB so we lowercase both sides
    // for the membership check; what we actually push is bible's saved
    // case from the scan result.
    const existingChars = new Set(
      (found.entry.allCharacters || []).map((n) => String(n).toLowerCase())
    );
    const newAlts = result.alts.filter(
      (alt) => !existingChars.has(String(alt.name).toLowerCase())
    );

    if (newAlts.length === 0) {
      await interaction.editReply({
        content:
          `✅ Scan complete. All ${result.alts.length} discovered alts are already in ` +
          `**${name}**'s ${LIST_LABELS[found.type].label} entry. Nothing to add.`,
      });
      return;
    }

    const sessionId = newSessionId();
    const expireTimer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS);
    sessions.set(sessionId, {
      sessionId,
      callerId: interaction.user.id,
      type: found.type,
      entryId: String(found.entry._id),
      entryName: found.entry.name,
      newAlts: newAlts.map((a) => ({
        name: a.name,
        classId: a.classId,
        itemLevel: a.itemLevel,
      })),
      scanStats: {
        scanned: result.scannedCandidates,
        failed: result.failedCandidates,
        totalAlts: result.alts.length,
        guildName: meta.guildName,
      },
      createdAt: Date.now(),
      expireTimer,
    });

    const ctx = LIST_LABELS[found.type];
    const altLines = newAlts
      .map((a, i) => {
        const cls = getClassName(a.classId) || a.classId || 'Unknown';
        const ilvl = typeof a.itemLevel === 'number' ? a.itemLevel.toFixed(2) : a.itemLevel;
        return `**${i + 1}.** ${a.name} · ${cls} · \`${ilvl}\``;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`${ctx.icon} Enrich preview — ${found.entry.name}`)
      .setDescription(
        `Stronghold scan in **${meta.guildName}** matched ${result.alts.length} alt(s). ` +
        `${newAlts.length} are not yet in this ${ctx.label} entry.\n\n${altLines}\n\n` +
        `Click **Confirm** to append all ${newAlts.length} to \`allCharacters\`, or **Cancel** to discard.`
      )
      .setColor(ctx.color)
      .setFooter({
        text:
          `Scanned ${result.scannedCandidates} candidates, ` +
          `${result.failedCandidates} failed · Session expires in 5 min`,
      });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`list-enrich:confirm:${sessionId}`)
        .setLabel(`Confirm Add ${newAlts.length}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`list-enrich:cancel:${sessionId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content: '',
      embeds: [embed],
      components: [row],
    });
  }

  async function handleListEnrichConfirmButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ This enrich session has expired. Re-run `/la-list enrich` to try again.',
        ephemeral: true,
      });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await interaction.reply({
        content: '⛔ Only the officer who started this enrich session can confirm it.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    const Model = MODELS_BY_TYPE[session.type];
    if (!Model) {
      await interaction.editReply({
        content: `❌ Internal error: unknown list type "${session.type}".`,
        embeds: [],
        components: [],
      });
      return;
    }

    await connectDB();
    const altNames = session.newAlts.map((a) => a.name);
    const updateResult = await Model.updateOne(
      { _id: session.entryId },
      { $addToSet: { allCharacters: { $each: altNames } } }
    );

    clearTimeout(session.expireTimer);
    sessions.delete(sessionId);

    const ctx = LIST_LABELS[session.type];
    const embed = new EmbedBuilder()
      .setTitle(`${ctx.icon} Enriched ${session.entryName}`)
      .setDescription(
        `Appended ${altNames.length} alt(s) to ${ctx.label} entry's \`allCharacters\`:\n\n` +
        altNames.map((n, i) => `${i + 1}. ${n}`).join('\n')
      )
      .setColor(ctx.color)
      .setFooter({
        text: `matched=${updateResult.matchedCount} modified=${updateResult.modifiedCount}`,
      })
      .setTimestamp(new Date());

    await interaction.editReply({
      content: '',
      embeds: [embed],
      components: [],
    });
  }

  async function handleListEnrichCancelButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.update({
        content: '⚠️ Session expired.',
        embeds: [],
        components: [],
      });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await interaction.reply({
        content: '⛔ Only the officer who started this enrich session can cancel it.',
        ephemeral: true,
      });
      return;
    }

    clearTimeout(session.expireTimer);
    sessions.delete(sessionId);

    await interaction.update({
      content: 'Cancelled — no changes made to the entry.',
      embeds: [],
      components: [],
    });
  }

  return {
    handleListEnrichCommand,
    handleListEnrichConfirmButton,
    handleListEnrichCancelButton,
  };
}
