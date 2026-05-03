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

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import {
  fetchCharacterMeta,
  fetchGuildMembers,
  detectAltsViaStronghold,
} from '../../../services/rosterService.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { isOfficerOrSenior } from '../helpers.js';
import {
  findEntryByName,
  LIST_LABELS,
  MODELS_BY_TYPE,
} from './data.js';
import {
  clearEnrichSession,
  createEnrichSession,
  getCooldownWaitSeconds,
  getEnrichSession,
  markCooldown,
} from './state.js';
import {
  buildEnrichPreviewReply,
  buildEnrichSuccessEmbed,
} from './ui.js';

export function createEnrichHandlers({ client, services }) {
  // services may grow Phase 3.5 broadcast support later; not used today.
  // eslint-disable-next-line no-unused-vars
  const _services = services;

  async function handleListEnrichCommand(interaction) {
    if (!isOfficerOrSenior(interaction.user.id)) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Officer-Only Command',
          description: 'Only officers and senior approvers can run `/la-list enrich`.',
        })],
        ephemeral: true,
      });
      return;
    }

    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);
    const cap = interaction.options.getInteger('deep_limit') ?? config.strongholdDeepCandidateLimit;

    const cooldownWait = getCooldownWaitSeconds(name);
    if (cooldownWait > 0) {
      await interaction.reply({
        content: `⏳ Please wait ${cooldownWait}s before re-enriching **${name}**.`,
        ephemeral: true,
      });
      return;
    }
    markCooldown(name);

    await interaction.deferReply();
    await connectDB();

    const found = await findEntryByName(name);
    if (!found) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'No List Entry',
          description: `**${name}** has no entry in any list.`,
          footer: 'Use /la-list add to create the entry first; enrich only appends to existing entries.',
        })],
      });
      return;
    }

    // Up-front bible probe so we can fail fast on no-guild / no-stronghold
    // before paying the multi-minute candidate fan-out. ScraperAPI is
    // allowed for this single-request probe because bible direct can flap
    // 429/503 and a one-off fallback is cheap quota-wise; the high-fanout
    // candidate scan below stays direct-only via useScraperApiForCandidates.
    const meta = await fetchCharacterMeta(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    });
    if (!meta) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Profile Not Found',
          description: `Could not fetch character meta for **${name}** from lostark.bible.`,
          footer: 'Profile may be hidden, the name may be misspelled, or bible may be temporarily down.',
        })],
      });
      return;
    }
    if (!meta.guildName) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'No Guild on Bible',
          description: `**${name}** has no guild listed on lostark.bible. Stronghold deep scan requires a guild member list to walk.`,
          footer: 'Use /la-list edit additional_names to manually append known alts when auto-discovery is impossible.',
        })],
      });
      return;
    }

    // Surface scan-in-progress to the channel so the officer knows the
    // command is alive during the long fetch fan-out. Single update,
    // no streaming — Discord webhook edits are cheap and Operations
    // already monitor server logs for the per-25 progress lines.
    // Guild member fetch is one request, so ScraperAPI fallback is on
    // (cheap) when bible direct flaps. Per-candidate scan below stays
    // direct-only.
    const guildMembers = await fetchGuildMembers(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      cacheKey: meta.guildName,
    });
    if (guildMembers.length === 0) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Guild Member List Unavailable',
          description: `Could not fetch the guild member list for **${name}** even with ScraperAPI fallback.`,
          footer: 'Bible may be down or the guild is empty; try again in a few minutes.',
        })],
      });
      return;
    }

    await interaction.editReply({
      content:
        `🔍 Running stronghold deep scan for **${name}** in guild **${meta.guildName}**` +
        ` (${guildMembers.length} guild members, cap ${cap}, concurrency ${config.strongholdDeepConcurrency}, candidate ScraperAPI off). ` +
        `Expect roughly 5-7 minutes; do not click anything.`,
    });

    // Per-candidate scan stays direct-only to protect ScraperAPI quota
    // (this is the high-fanout path the .env warning is about). targetMeta
    // and guildMembers are pre-supplied above so allowScraperApiForTarget /
    // allowScraperApiForGuild inside the detector are no-ops here.
    const result = await detectAltsViaStronghold(name, {
      targetMeta: meta,
      guildMembers,
      candidateLimit: cap,
      useScraperApiForCandidates: false,
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

    const session = createEnrichSession({
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
    });

    await interaction.editReply(buildEnrichPreviewReply({
      entry: found.entry,
      foundType: found.type,
      meta,
      newAlts,
      result,
      sessionId: session.sessionId,
    }));
  }

  async function handleListEnrichConfirmButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = getEnrichSession(sessionId);
    if (!session) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Session Expired',
          description: 'This enrich preview is older than the 5-minute session window.',
          footer: 'Re-run /la-list enrich to start a fresh scan.',
        })],
        ephemeral: true,
      });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Not Your Session',
          description: 'Only the officer who started this enrich session can confirm it.',
        })],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    const Model = MODELS_BY_TYPE[session.type];
    if (!Model) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Internal Error',
          description: `Unknown list type "${session.type}".`,
          footer: 'Report this to an officer; the entry was not modified.',
        })],
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

    clearEnrichSession(sessionId);

    await interaction.editReply({
      content: '',
      embeds: [buildEnrichSuccessEmbed(session, updateResult)],
      components: [],
    });
  }

  async function handleListEnrichCancelButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = getEnrichSession(sessionId);
    if (!session) {
      await interaction.update({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Session Expired',
          description: 'This enrich preview is older than the 5-minute session window.',
        })],
        components: [],
      });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Not Your Session',
          description: 'Only the officer who started this enrich session can cancel it.',
        })],
        ephemeral: true,
      });
      return;
    }

    clearEnrichSession(sessionId);

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
