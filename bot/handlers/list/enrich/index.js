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
import { ICONS } from '../../../utils/ui.js';
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
  buildEnrichProgressEmbed,
  buildEnrichSuccessEmbed,
} from './ui.js';

// Discord webhook edits are rate-limited (5 per 5s). Throttle progress
// updates so the scan worker isn't bottlenecked on Discord; 30s gives
// ~10-14 updates over a 5-7 minute scan, plenty for live signal.
const PROGRESS_EDIT_THROTTLE_MS = 30 * 1000;

export function createEnrichHandlers({ client, services }) {
  // services may grow Phase 3.5 broadcast support later; not used today.
  // eslint-disable-next-line no-unused-vars
  const _services = services;

  /**
   * Runs the enrich pipeline post-validation. Caller is responsible for:
   *   - permission gate (officer/senior)
   *   - cooldown gate + markCooldown
   *   - deferReply (this function only does editReply afterwards)
   *
   * Used by both the slash command (handleListEnrichCommand) and the
   * "Enrich now" button shipped on the /la-list add success card when
   * the entry was created against a hidden roster.
   */
  async function runEnrichFlow(interaction, { name, cap }) {
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

    // Initial scan-started embed. The onProgress callback below will edit
    // this same message with live progress every 30s as the scan runs.
    const startedAt = Date.now();
    const initialProgress = {
      scannedCandidates: 0,
      totalCandidates: Math.min(
        guildMembers.filter((m) => m.name !== name && m.ilvl >= 1700).length,
        cap || guildMembers.length
      ),
      failedCandidates: 0,
      altsFound: 0,
      // Gentle mode (the default) walks one candidate at a time on a
      // 1.5s throttle. Surface that as the initial backoff value so the
      // progress embed reads correctly even on its very first paint
      // before the scan has ramped its adaptive backoff.
      currentBackoffMs: 1500,
      totalMembers: guildMembers.length,
      startedAt,
    };
    await interaction.editReply({
      content: '',
      embeds: [buildEnrichProgressEmbed({
        entry: found.entry,
        foundType: found.type,
        meta,
        progress: initialProgress,
      })],
    });

    let lastProgressEdit = startedAt;
    const onProgress = (progress) => {
      const now = Date.now();
      const isFinal = progress.scannedCandidates >= progress.totalCandidates;
      if (!isFinal && now - lastProgressEdit < PROGRESS_EDIT_THROTTLE_MS) {
        return; // throttled; next tick will catch up
      }
      lastProgressEdit = now;
      // Skip the final "100%" tick because the post-scan branch below
      // overwrites the embed with either preview-with-alts or
      // no-alts-matched immediately afterwards.
      if (isFinal) return;
      interaction.editReply({
        content: '',
        embeds: [buildEnrichProgressEmbed({
          entry: found.entry,
          foundType: found.type,
          meta,
          progress: { ...progress, totalMembers: guildMembers.length, startedAt },
        })],
      }).catch((err) => {
        console.warn('[enrich] Progress edit failed:', err?.message || err);
      });
    };

    // Per-candidate scan stays direct-only to protect ScraperAPI quota
    // (this is the high-fanout path the .env warning is about). targetMeta
    // and guildMembers are pre-supplied above so allowScraperApiForTarget /
    // allowScraperApiForGuild inside the detector are no-ops here.
    const result = await detectAltsViaStronghold(name, {
      targetMeta: meta,
      guildMembers,
      candidateLimit: cap,
      useScraperApiForCandidates: false,
      onProgress,
    });

    if (!result || !Array.isArray(result.alts) || result.alts.length === 0) {
      const ctx = LIST_LABELS[found.type];
      await interaction.editReply({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.INFO,
          titleIcon: ICONS.search,
          color: ctx.color,
          title: `Scan complete · ${name}`,
          description:
            `No alts matched the target stronghold in **${meta.guildName}**.`,
          fields: [
            {
              name: 'Scanned',
              value: `${result?.scannedCandidates ?? 0} candidates`,
              inline: true,
            },
            {
              name: 'Failed',
              value: `${result?.failedCandidates ?? 0}`,
              inline: true,
            },
          ],
          footer:
            (result?.failedCandidates ?? 0) > 0
              ? 'High failure count usually means bible was rate-limiting; retry in a few minutes.'
              : 'Either the target has no alts in this guild, or all alts are below ilvl 1700.',
        })],
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
    await runEnrichFlow(interaction, { name, cap });
  }

  /**
   * Triggered by the "Enrich now" button posted on a /la-list add
   * success card when the entry was created against a hidden roster.
   * customId shape: `list-add:enrich-hidden:<encodedName>`
   *
   * Same officer + cooldown gating as the slash command, but seeded
   * from the button's customId instead of slash options. Default cap.
   */
  async function handleListAddEnrichHiddenButton(interaction) {
    if (!isOfficerOrSenior(interaction.user.id)) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Officer-Only Action',
          description: 'Only officers and senior approvers can trigger an enrich scan.',
        })],
        ephemeral: true,
      });
      return;
    }

    const parts = interaction.customId.split(':');
    const encoded = parts.slice(2).join(':');
    const rawName = decodeURIComponent(encoded || '').trim();
    if (!rawName) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Invalid Button',
          description: 'Could not read the entry name from the button. Use `/la-list enrich` directly.',
        })],
        ephemeral: true,
      });
      return;
    }

    const name = normalizeCharacterName(rawName);
    const cap = config.strongholdDeepCandidateLimit;

    const cooldownWait = getCooldownWaitSeconds(name);
    if (cooldownWait > 0) {
      await interaction.reply({
        content: `⏳ Please wait ${cooldownWait}s before re-enriching **${name}**.`,
        ephemeral: true,
      });
      return;
    }
    markCooldown(name);

    // Reply (not update) so the original add success card stays
    // intact; the progress embed posts as a new message in the same
    // channel and the officer can scroll back to the add card if
    // they need the entry context.
    await interaction.deferReply();
    await runEnrichFlow(interaction, { name, cap });
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
    handleListAddEnrichHiddenButton,
    handleListEnrichConfirmButton,
    handleListEnrichCancelButton,
  };
}
