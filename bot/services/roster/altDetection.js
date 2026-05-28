/**
 * services/roster/altDetection.js
 * Stronghold-based alt detection. Fans out across a target's guild
 * members + bible meta lookups to find characters that share the same
 * stronghold name (= same player account). Two modes: 'gentle'
 * (sequential, 1.5s throttle, transient retry, current default) and
 * 'fast' (concurrency 3, no retry). Gentle is the default since the
 * 2026-05-03 peak-hour incident · fast mode should only be used
 * off-peak when bible is cool.
 */

import config from '../../config.js';
import { getClassName } from '../../models/Class.js';
import {
  getCurrentScraperApiUsageScopeSnapshot,
  runWithScraperApiUsageScope,
} from '../../utils/scraperApiUsage.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { fetchGuildMembers } from './guildMembers.js';
import { inferHiddenRosterItemLevel } from './search.js';

/**
 * Detect alt characters via the target's stronghold name. Runs inside a
 * scraperapi-usage scope so per-call counters surface in the audit
 * trail. Returns null when the target has no guild / no stronghold or
 * the meta lookup fails.
 * @param {string} name - target character name
 * @param {object} [options] - see options destructure inside (mode,
 *   concurrency, viaWorker, candidateLimit, target/guild meta overrides)
 * @returns {Promise<object|null>} alt detection result · see callers in
 *   handlers/list/enrich, handlers/list/multiadd, services/multiadd
 */
export async function detectAltsViaStronghold(name, options = {}) {
  return runWithScraperApiUsageScope(() => detectAltsViaStrongholdInScope(name, options));
}

async function detectAltsViaStrongholdInScope(name, options = {}) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);
  const candidateLimit = options.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const candidateTimeoutMs = options.candidateTimeoutMs ?? config.strongholdDeepCandidateTimeoutMs;
  const useScraperApiForCandidates = options.useScraperApiForCandidates ?? config.strongholdDeepUseScraperApi;
  const allowScraperApiForTarget = options.allowScraperApiForTarget !== false;
  const allowScraperApiForGuild = options.allowScraperApiForGuild !== false;
  // Heavy fan-out flow: every bible request inside this detector should
  // go through the worker when the caller opted in (enrich / deep /
  // hidden roster). Plain `useScraperApiForCandidates` only covers the
  // candidate loop; viaWorker also covers the upstream meta + guild
  // probes so the whole chain bypasses Railway's CF-blocked IP.
  const viaWorker = options.viaWorker === true;

  // Mode selection. The Phase 1 verification scan that found Ainslinn's
  // 5 alts ran in 'gentle' mode (sequential, 1.5s throttle, transient retry).
  // 'fast' mode (concurrency 3, no retry, 300ms backoff floor) was the
  // original production default; Bao's 2026-05-03 peak-hour run on
  // Ainslinn hit 100% failure with fast mode because bible was
  // blanket-rejecting requests. Default switched to 'gentle' so Bao's
  // case recovers.
  //
  // Power users can opt back into fast mode via `mode: 'fast'`. They
  // should only do that off-peak, when bible is cool.
  const mode = options.mode === 'fast' ? 'fast' : 'gentle';
  const isGentle = mode === 'gentle';
  const concurrency = isGentle
    ? 1
    : Math.max(1, Math.min(options.concurrency ?? config.strongholdDeepConcurrency, 12));
  const retryOnRateLimit = options.retryOnRateLimit ?? isGentle;
  const backoffFloorMs = isGentle ? 1500 : config.scanBackoffMinMs;
  const rateLimitRetryDelayMs = options.rateLimitRetryDelayMs ?? (isGentle ? 8000 : undefined);
  const failureGuardMinCandidates = options.failureGuardMinCandidates
    ?? config.strongholdDeepFailureGuardMinCandidates;
  const failureGuardFailedRate = options.failureGuardFailedRate
    ?? config.strongholdDeepFailureGuardRate;

  const meta = options.targetMeta || await fetchCharacterMeta(name, {
    allowScraperApi: allowScraperApiForTarget,
    timeoutMs: options.targetTimeoutMs ?? candidateTimeoutMs,
    fallbackOnRateLimit: false,
    viaWorker,
  });
  if (!meta) {
    console.log('[alt-detect] No character meta found.');
    return null;
  }
  if (!meta.guildName) {
    console.log('[alt-detect] Character has no guild.');
    return null;
  }
  if (!meta.strongholdName) {
    console.log('[alt-detect] No stronghold data.');
    return null;
  }

  const targetItemLevel = options.targetItemLevel ?? meta.itemLevel ?? await inferHiddenRosterItemLevel(name);

  console.log(`[alt-detect] Target: SH "${meta.strongholdName}" Lv.${meta.strongholdLevel}, RL ${meta.rosterLevel}, Guild "${meta.guildName}"`);

  const members = Array.isArray(options.guildMembers)
    ? options.guildMembers
    : await fetchGuildMembers(name, {
        allowScraperApi: allowScraperApiForGuild,
        timeoutMs: options.guildTimeoutMs ?? candidateTimeoutMs,
        cacheKey: options.guildMembersCacheKey || meta.guildName,
        viaWorker,
      });
  if (members.length === 0) {
    console.log('[alt-detect] No guild members found.');
    return null;
  }

  console.log(`[alt-detect] Guild has ${members.length} members. Checking for Stronghold matches...`);

  // excludeNames lets a Continue-scan resume skip already-scanned candidates
  // from the prior pass. Stored case-insensitive on the input side so callers
  // don't have to match bible's capitalisation exactly.
  const excludeSet = new Set(
    (Array.isArray(options.excludeNames) ? options.excludeNames : [])
      .map((n) => String(n).toLowerCase())
  );
  const baseCandidates = members
    .filter((m) => m.name !== name && m.ilvl >= 1700)
    .sort((a, b) => (b.ilvl || 0) - (a.ilvl || 0));
  const candidates = excludeSet.size > 0
    ? baseCandidates.filter((m) => !excludeSet.has(String(m.name).toLowerCase()))
    : baseCandidates;
  const excludedCandidates = baseCandidates.length - candidates.length;
  const limitedCandidates = candidateLimit > 0 ? candidates.slice(0, candidateLimit) : candidates;
  const skippedCandidates = Math.max(0, candidates.length - limitedCandidates.length);
  console.log(
    `[alt-detect] ${candidates.length} candidate(s) after filtering ilvl >= 1700; scanning ${limitedCandidates.length}`
    + (skippedCandidates > 0 ? `, skipping ${skippedCandidates} by limit` : '')
    + `. Mode: ${mode}. Candidate ScraperAPI: ${useScraperApiForCandidates ? 'on' : 'off'}. Concurrency: ${concurrency}. Transient retry: ${retryOnRateLimit ? 'on' : 'off'}.`
  );

  const alts = [];
  // scannedNames captures only candidates with successfully parsed meta.
  // Failed attempts are deliberately excluded so Continue can retry them
  // later instead of permanently skipping profiles that bible rejected.
  const scannedNames = [];
  const attemptedNames = [];
  const failedNames = [];
  const failureReasons = new Map();
  let lastFailureReason = '';
  let failedCandidates = 0;
  let attemptedCandidates = 0;
  let checkedCandidates = 0;
  let nextCandidateIndex = 0;
  let rateLimitRetries = 0;
  let pausedForFailureStorm = false;
  let abortReason = '';
  let abortLabel = '';
  let abortDetail = '';

  console.log(`[alt-detect] Scanning ${limitedCandidates.length} candidate(s)...`);

  // Backoff floor matches mode: gentle = 1500ms (POC pace), fast = env
  // default (300ms). Both modes ramp up to scanBackoffMaxMs (3000ms)
  // on consecutive failures, recovering 100ms per success.
  const backoff = {
    current: backoffFloorMs,
    min: backoffFloorMs,
    max: isGentle ? Math.max(config.scanBackoffMaxMs, 8000) : config.scanBackoffMaxMs,
    step: 500,
    rateLimitStep: 1500,
    recover: 100,
  };

  // Cancel flag is mutated externally (e.g. by a Stop button click).
  // Worker checks at the top of each candidate loop and exits early
  // when set, so the caller gets a partial-result return.
  const cancelFlag = options.cancelFlag || { cancelled: false };
  let cancelledByFlag = false;

  function shouldPauseForFailureStorm() {
    if (!failureGuardMinCandidates || !failureGuardFailedRate) return false;
    if (attemptedCandidates < failureGuardMinCandidates) return false;
    return failedCandidates / attemptedCandidates >= failureGuardFailedRate;
  }

  function recordFailureReason(reason) {
    const normalized = String(reason || 'profile meta unavailable').trim() || 'profile meta unavailable';
    lastFailureReason = normalized;
    failureReasons.set(normalized, (failureReasons.get(normalized) || 0) + 1);
  }

  async function scanWorker() {
    while (nextCandidateIndex < limitedCandidates.length) {
      if (cancelFlag.cancelled) {
        cancelledByFlag = true;
        abortReason = cancelFlag.reason || 'user-stopped';
        abortLabel = cancelFlag.label || 'Stopped by user';
        abortDetail = cancelFlag.detail || 'Stop button clicked.';
        break;
      }
      if (pausedForFailureStorm) {
        break;
      }
      const cand = limitedCandidates[nextCandidateIndex++];
      attemptedNames.push(cand.name);
      let candidateRateLimitRetries = 0;
      let candidateFailureReason = '';
      const candMeta = await fetchCharacterMeta(cand.name, {
        allowScraperApi: useScraperApiForCandidates,
        preferScraperApi: useScraperApiForCandidates,
        fallbackOnRateLimit: useScraperApiForCandidates,
        retryOnRateLimit,
        rateLimitRetryDelayMs,
        suppressRetryWarnings: isGentle,
        viaWorker,
        onMetaFetchResult: ({ phase, status, ok, error }) => {
          if (error) {
            candidateFailureReason = `${phase} ${error.message || 'fetch failed'}`;
          } else if (!ok) {
            candidateFailureReason = `${phase} HTTP ${status}`;
          }
        },
        onRetryableStatus: ({ status }) => {
          if (status === 429) {
            candidateRateLimitRetries++;
            rateLimitRetries++;
          }
        },
        timeoutMs: candidateTimeoutMs,
      });

      attemptedCandidates++;
      if (candidateRateLimitRetries > 0) {
        // Multiplicative backoff on 429 (rather than linear +1500ms per
        // retry). 1.6x grows fast enough that two consecutive rate-limits
        // double the gap, which matches the pace bible's app-level
        // limiter expects when it fires. Linear addition was slow to
        // recover and predictable - bot-detection signal in disguise.
        backoff.current = Math.min(
          Math.round(backoff.current * Math.pow(1.6, candidateRateLimitRetries)),
          backoff.max
        );
      }
      if (candMeta === null) {
        failedCandidates++;
        failedNames.push(cand.name);
        recordFailureReason(candidateFailureReason);
        backoff.current = Math.min(backoff.current + backoff.step, backoff.max);
      } else {
        checkedCandidates++;
        scannedNames.push(cand.name);
        if (candidateRateLimitRetries === 0) {
          backoff.current = Math.max(backoff.current - backoff.recover, backoff.min);
        }
        if (candMeta.strongholdName === meta.strongholdName && candMeta.rosterLevel === meta.rosterLevel) {
          alts.push({
            name: cand.name,
            classId: cand.cls,
            className: getClassName(cand.cls),
            itemLevel: cand.ilvl,
            rank: cand.rank,
          });
          console.log(`[alt-detect] Match found: ${cand.name}`);
        }
      }

      // Console log stays per-25 (operator-facing). UI progress emits
      // per-5 so the embed can pulse faster between throttled edits;
      // the caller decides how often to actually push to Discord.
      if (attemptedCandidates % 25 === 0 || attemptedCandidates === limitedCandidates.length) {
        console.log(
          `[alt-detect] Progress ${attemptedCandidates}/${limitedCandidates.length};` +
          ` checked ${checkedCandidates};` +
          ` failed ${failedCandidates}; alts ${alts.length};` +
          ` rate-limit retries ${rateLimitRetries}; backoff ${backoff.current}ms`
        );
      }
      if (
        attemptedCandidates % 5 === 0
        || attemptedCandidates === limitedCandidates.length
        || alts.length > 0 && attemptedCandidates % 1 === 0
      ) {
        if (typeof options.onProgress === 'function') {
          // Pass a snapshot of the alts array (shallow copy of the
          // current matches) so the UI can render names live as the
          // scan finds them. Truncate to top-N inside the UI if the
          // embed gets too long; we don't truncate here so the caller
          // has full freedom.
          Promise.resolve(options.onProgress({
            scannedCandidates: attemptedCandidates,
            checkedCandidates,
            attemptedCandidates,
            totalCandidates: limitedCandidates.length,
            failedCandidates,
            altsFound: alts.length,
            alts: alts.slice(),
            currentBackoffMs: backoff.current,
            rateLimitRetries,
            lastFailureReason,
            failureReasons: Object.fromEntries(failureReasons),
          })).catch((err) => {
            console.warn('[alt-detect] onProgress callback threw:', err?.message || err);
          });
        }
      }

      if (shouldPauseForFailureStorm()) {
        pausedForFailureStorm = true;
        abortReason = 'bible-failure-storm';
        abortLabel = 'Bible rejected candidate profiles';
        abortDetail = `${failedCandidates}/${attemptedCandidates} candidate attempts failed.` +
          (lastFailureReason ? ` Last error: ${lastFailureReason}.` : '');
        console.warn(
          `[alt-detect] Pausing ${name}: high failure rate ` +
          `${failedCandidates}/${attemptedCandidates} (${Math.round((failedCandidates / attemptedCandidates) * 100)}%).`
        );
        break;
      }

      if (nextCandidateIndex < limitedCandidates.length) {
        // Jitter the inter-candidate sleep by +/- 15% so the cadence
        // is not a perfectly periodic signal CF / bible's anti-bot
        // heuristics can clock. 0.85x .. 1.15x of backoff.current.
        const jitterFactor = 0.85 + Math.random() * 0.3;
        const sleepMs = Math.round(backoff.current * jitterFactor);
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, limitedCandidates.length) }, () => scanWorker())
  );

  console.log(`[alt-detect] Found ${alts.length} alt(s) for ${name}.`);
  const scraperApiUsage = getCurrentScraperApiUsageScopeSnapshot();

  return {
    target: {
      name,
      classId: meta.classId,
      className: getClassName(meta.classId),
      itemLevel: targetItemLevel,
      rosterLevel: meta.rosterLevel,
      strongholdName: meta.strongholdName,
      strongholdLevel: meta.strongholdLevel,
      guildName: meta.guildName,
      guildGrade: meta.guildGrade,
    },
    alts,
    scannedNames,
    attemptedNames,
    failedNames,
    totalMembers: members.length,
    // totalEligibleInGuild is invariant across multiple Continue passes
    // (it counts every guild member ilvl >= 1700 minus the target) so
    // a cumulative remaining-count stays correct across passes.
    // eligibleCandidates is per-pass (after exclude) and is what the
    // scanner actually had to choose from in THIS run.
    totalEligibleInGuild: baseCandidates.length,
    eligibleCandidates: candidates.length,
    totalCandidates: limitedCandidates.length,
    scannedCandidates: checkedCandidates,
    checkedCandidates,
    attemptedCandidates,
    skippedCandidates,
    excludedCandidates,
    failedCandidates,
    lastFailureReason,
    failureReasons: Object.fromEntries(failureReasons),
    rateLimitRetries,
    candidateLimit,
    concurrency,
    candidateTimeoutMs,
    usedScraperApiForCandidates: useScraperApiForCandidates,
    scraperApiRequests: scraperApiUsage.totalRequests,
    mode,
    retryOnRateLimit,
    pausedForFailureStorm,
    abortReason,
    abortLabel,
    abortDetail,
    cancelled: cancelledByFlag,
  };
}
