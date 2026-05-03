import config from '../../config.js';
import { getClassName } from '../../models/Class.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { fetchGuildMembers } from './guildMembers.js';
import { inferHiddenRosterItemLevel } from './search.js';

export async function detectAltsViaStronghold(name, options = {}) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);
  const candidateLimit = options.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? config.strongholdDeepConcurrency, 12));
  const candidateTimeoutMs = options.candidateTimeoutMs ?? config.strongholdDeepCandidateTimeoutMs;
  const useScraperApiForCandidates = options.useScraperApiForCandidates ?? config.strongholdDeepUseScraperApi;
  const allowScraperApiForTarget = options.allowScraperApiForTarget !== false;
  const allowScraperApiForGuild = options.allowScraperApiForGuild !== false;

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
    + `. Candidate ScraperAPI: ${useScraperApiForCandidates ? 'on' : 'off'}. Concurrency: ${concurrency}.`
  );

  const alts = [];
  let failedCandidates = 0;
  let scannedCandidates = 0;
  let nextCandidateIndex = 0;

  console.log(`[alt-detect] Scanning ${limitedCandidates.length} candidate(s)...`);

  const backoff = {
    current: config.scanBackoffMinMs,
    min: config.scanBackoffMinMs,
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
        retryOnRateLimit: false,
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
  };
}
