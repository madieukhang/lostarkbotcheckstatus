import config from '../../config.js';
import { getClassName } from '../../models/Class.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { fetchGuildMembers } from './guildMembers.js';
import { inferHiddenRosterItemLevel } from './search.js';

export async function detectAltsViaStronghold(name, options = {}) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);
  const candidateLimit = options.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const candidateTimeoutMs = options.candidateTimeoutMs ?? config.strongholdDeepCandidateTimeoutMs;
  const useScraperApiForCandidates = options.useScraperApiForCandidates ?? config.strongholdDeepUseScraperApi;
  const allowScraperApiForTarget = options.allowScraperApiForTarget !== false;
  const allowScraperApiForGuild = options.allowScraperApiForGuild !== false;

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

  const meta = options.targetMeta || await fetchCharacterMeta(name, {
    allowScraperApi: allowScraperApiForTarget,
    timeoutMs: options.targetTimeoutMs ?? candidateTimeoutMs,
    fallbackOnRateLimit: false,
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
      });
  if (members.length === 0) {
    console.log('[alt-detect] No guild members found.');
    return null;
  }

  console.log(`[alt-detect] Guild has ${members.length} members. Checking for Stronghold matches...`);

  const candidates = members
    .filter((m) => m.name !== name && m.ilvl >= 1700)
    .sort((a, b) => (b.ilvl || 0) - (a.ilvl || 0));
  const limitedCandidates = candidateLimit > 0 ? candidates.slice(0, candidateLimit) : candidates;
  const skippedCandidates = Math.max(0, candidates.length - limitedCandidates.length);
  console.log(
    `[alt-detect] ${candidates.length} candidate(s) after filtering ilvl >= 1700; scanning ${limitedCandidates.length}`
    + (skippedCandidates > 0 ? `, skipping ${skippedCandidates} by limit` : '')
    + `. Mode: ${mode}. Candidate ScraperAPI: ${useScraperApiForCandidates ? 'on' : 'off'}. Concurrency: ${concurrency}. Transient retry: ${retryOnRateLimit ? 'on' : 'off'}.`
  );

  const alts = [];
  let failedCandidates = 0;
  let scannedCandidates = 0;
  let nextCandidateIndex = 0;

  console.log(`[alt-detect] Scanning ${limitedCandidates.length} candidate(s)...`);

  // Backoff floor matches mode: gentle = 1500ms (POC pace), fast = env
  // default (300ms). Both modes ramp up to scanBackoffMaxMs (3000ms)
  // on consecutive failures, recovering 100ms per success.
  const backoff = {
    current: backoffFloorMs,
    min: backoffFloorMs,
    max: config.scanBackoffMaxMs,
    step: 500,
    recover: 100,
  };

  async function scanWorker() {
    while (nextCandidateIndex < limitedCandidates.length) {
      const cand = limitedCandidates[nextCandidateIndex++];
      const candMeta = await fetchCharacterMeta(cand.name, {
        allowScraperApi: useScraperApiForCandidates,
        preferScraperApi: useScraperApiForCandidates,
        fallbackOnRateLimit: useScraperApiForCandidates,
        retryOnRateLimit,
        timeoutMs: candidateTimeoutMs,
      });

      scannedCandidates++;
      if (candMeta === null) {
        failedCandidates++;
        backoff.current = Math.min(backoff.current + backoff.step, backoff.max);
      } else {
        backoff.current = Math.max(backoff.current - backoff.recover, backoff.min);
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

      if (scannedCandidates % 25 === 0 || scannedCandidates === limitedCandidates.length) {
        console.log(
          `[alt-detect] Progress ${scannedCandidates}/${limitedCandidates.length};` +
          ` failed ${failedCandidates}; alts ${alts.length}; backoff ${backoff.current}ms`
        );
        // Surface progress to caller (e.g. Discord embed update). Fire-and-
        // forget so a slow / rate-limited UI edit does not block the next
        // candidate fetch. The caller is expected to throttle its own
        // edits if it needs to respect external rate limits.
        if (typeof options.onProgress === 'function') {
          Promise.resolve(options.onProgress({
            scannedCandidates,
            totalCandidates: limitedCandidates.length,
            failedCandidates,
            altsFound: alts.length,
            currentBackoffMs: backoff.current,
          })).catch((err) => {
            console.warn('[alt-detect] onProgress callback threw:', err?.message || err);
          });
        }
      }

      if (nextCandidateIndex < limitedCandidates.length) {
        await new Promise((r) => setTimeout(r, backoff.current));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, limitedCandidates.length) }, () => scanWorker())
  );

  console.log(`[alt-detect] Found ${alts.length} alt(s) for ${name}.`);

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
    totalMembers: members.length,
    scannedCandidates,
    skippedCandidates,
    failedCandidates,
    candidateLimit,
    concurrency,
    candidateTimeoutMs,
    usedScraperApiForCandidates: useScraperApiForCandidates,
    mode,
    retryOnRateLimit,
  };
}
