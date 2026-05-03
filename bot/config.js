/**
 * config.js
 * Loads and validates all environment variables from .env file.
 * Centralizes configuration so no sensitive data is hardcoded.
 */

// dotenv.config() is safe to call in all environments:
// - Locally: loads vars from .env file
// - On Railway: .env doesn't exist in the container, so this is a no-op.
//   Railway-injected vars in process.env are NEVER overridden by dotenv.
import dotenv from 'dotenv';
dotenv.config();

/**
 * Validate all required environment variables up-front.
 * Logs every missing key and exits cleanly so Railway shows a clear error.
 * @param {string[]} keys
 */
function validateEnv(keys) {
  // Debug: print which vars are present (names only, never values)
  console.log('[config] NODE_ENV:', process.env.NODE_ENV ?? '(not set)');
  console.log('[config] Env vars present:', keys.map((k) => `${k}=${process.env[k] ? '✓' : '✗'}`).join(', '));

  const missing = keys.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length > 0) {
    console.error('[config] Missing required environment variables:');
    missing.forEach((k) => console.error(`  - ${k}`));
    console.error('[config] Set these in the Railway Variables tab and redeploy.');
    process.exit(1);
  }
}

/**
 * Get a required environment variable (assumed already validated).
 * @param {string} key
 * @returns {string}
 */
function requireEnv(key) {
  return process.env[key].trim();
}

validateEnv(['DISCORD_TOKEN', 'CHANNEL_ID', 'MONGODB_URI']);

/**
 * Parse CHECK_INTERVAL from env (in seconds), fallback to 30s.
 * Enforces a minimum of 10 seconds to avoid hammering the server.
 */
function parseInterval() {
  const raw = parseInt(process.env.CHECK_INTERVAL, 10);
  if (isNaN(raw) || raw < 10) {
    console.warn('[config] CHECK_INTERVAL not set or too low – defaulting to 30 seconds.');
    return 30_000;
  }
  return raw * 1000; // convert to milliseconds
}

function parseBooleanEnv(key, defaultValue = false) {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase());
}

function parsePositiveIntEnv(key, defaultValue) {
  const raw = parseInt(process.env[key], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

const config = {
  /** Discord bot token */
  token: requireEnv('DISCORD_TOKEN'),

  /** ID of the channel where notifications are sent */
  channelId: requireEnv('CHANNEL_ID'),

  /** ID of the role to mention in notifications */
  // roleId: requireEnv('ROLE_ID'),

  /** How often to check server status (milliseconds) */
  checkIntervalMs: parseInterval(),

  /** MongoDB connection string */
  mongoUri: requireEnv('MONGODB_URI'),

  /** ScraperAPI keys (fallback chain) — SCRAPERAPI_KEY, SCRAPERAPI_KEY_2, SCRAPERAPI_KEY_3... */
  scraperApiKeys: [
    process.env.SCRAPERAPI_KEY,
    process.env.SCRAPERAPI_KEY_2,
    process.env.SCRAPERAPI_KEY_3,
  ]
    .map((k) => (k || '').trim())
    .filter(Boolean),

  /** @deprecated — use scraperApiKeys[0] instead (kept for backward compat) */
  get scraperApiKey() { return this.scraperApiKeys[0] || ''; },

  /** Approver IDs for /la-list add approval flow (comma-separated Discord user IDs) */
  officerApproverIds: (process.env.OFFICER_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  seniorApproverIds: (process.env.SENIOR_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  memberApproverIds: (process.env.MEMBER_APPROVER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /** Optional channel IDs to broadcast list add/remove notifications (comma-separated) */
  listNotifyChannelIds: (process.env.LIST_NOTIFY_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Optional channel IDs for auto-checking screenshots (comma-separated) */
  autoCheckChannelIds: (process.env.AUTO_CHECK_CHANNEL_IDS || process.env.AUTO_CHECK_CHANNEL_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Owner guild ID — this server can view all server-scoped blacklist entries from every guild */
  ownerGuildId: (process.env.OWNER_GUILD_ID || '').trim(),

  /** Optional Gemini API key for image-based /la-check name extraction */
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),

  /** Gemini model priority list for image parsing with auto-failover on quota limits */
  geminiModels: (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.1-flash-lite-preview,gemini-3-flash-preview')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),

  /**
   * Optional post-check Stronghold scan for flagged OCR names.
   * Disabled by default because it can fan out into many lostark.bible requests
   * after a single screenshot check.
   */
  listcheckAltEnrichmentEnabled: parseBooleanEnv('LISTCHECK_ALT_ENRICHMENT', false),
  listcheckAltEnrichmentLimit: parsePositiveIntEnv('LISTCHECK_ALT_ENRICHMENT_LIMIT', 1),
  listcheckAltEnrichmentCandidateLimit: parsePositiveIntEnv('LISTCHECK_ALT_ENRICHMENT_CANDIDATE_LIMIT', 80),

  /** OCR/list-check network bounds. These are direct-only by default; no ScraperAPI. */
  listcheckMaxNames: parsePositiveIntEnv('LISTCHECK_MAX_NAMES', 8),
  listcheckRosterLookupConcurrency: parsePositiveIntEnv('LISTCHECK_ROSTER_LOOKUP_CONCURRENCY', 3),
  listcheckRosterLookupStartSpacingMs: parsePositiveIntEnv('LISTCHECK_ROSTER_LOOKUP_START_SPACING_MS', 150),
  listcheckRosterLookupTimeoutMs: parsePositiveIntEnv('LISTCHECK_ROSTER_LOOKUP_TIMEOUT_MS', 6000),
  listcheckSimilarLookupLimit: parsePositiveIntEnv('LISTCHECK_SIMILAR_LOOKUP_LIMIT', 3),

  /** Short-lived Gemini OCR result cache for repeated checks of the same attachment URL. */
  ocrCacheTtlMs: parsePositiveIntEnv('OCR_CACHE_TTL_MS', 5 * 60 * 1000),
  ocrCacheMaxSize: parsePositiveIntEnv('OCR_CACHE_MAX_SIZE', 100),

  /**
   * Stronghold deep scans are intentionally bounded. Matching alts requires
   * fetching each guild candidate profile, so an unbounded scan can burn
   * ScraperAPI quota and take a long time on large guilds.
   *
   * Cap bumped 30 -> 300 after a real-data scan against Bullet Shell guild
   * (820 members, 437 candidates >= 1700 ilvl) showed the target's 5 alts
   * spread from candidate #70 down to #267 in the absolute ilvl-desc sort.
   * The legacy cap of 30 caught zero alts because the top of a large guild
   * is dominated by other accounts' multi-character whale clusters; the
   * target's own alts sit much further down the sort. Cap 300 covers any
   * plausible alt distribution in similarly large guilds; smaller guilds
   * simply finish early when candidates run out.
   *
   * Concurrency lowered 6 -> 3 because the scanWorker has no internal
   * throttle and concurrency 6 triggered immediate 429 storms on bible
   * (verified in smoke runs: 30/30 candidates failing back-to-back).
   * Concurrency 3 halves the burst rate and lets bible's rate limiter
   * recover between fan-outs. Wall-clock impact at the new cap: roughly
   * 5-7 min for a full 300-candidate scan in production.
   */
  strongholdDeepCandidateLimit: parsePositiveIntEnv('STRONGHOLD_DEEP_CANDIDATE_LIMIT', 300),
  strongholdDeepConcurrency: parsePositiveIntEnv('STRONGHOLD_DEEP_CONCURRENCY', 3),
  strongholdDeepCandidateTimeoutMs: parsePositiveIntEnv('STRONGHOLD_DEEP_CANDIDATE_TIMEOUT_MS', 8000),

  /**
   * In-memory meta cache for fetchCharacterMeta results. Stronghold +
   * rosterLevel are roster-account properties that drift on the order
   * of days, so a 30-minute TTL is well below their natural change
   * cadence while still letting back-to-back /la-roster deep + /la-list
   * enrich invocations hit warm cache. Max-size cap is a memory guard;
   * 5000 entries at ~200 bytes each is ~1 MB.
   */
  metaCacheTtlMs: parsePositiveIntEnv('META_CACHE_TTL_MS', 30 * 60 * 1000),
  metaCacheMaxSize: parsePositiveIntEnv('META_CACHE_MAX_SIZE', 5000),
  guildMembersCacheTtlMs: parsePositiveIntEnv('GUILD_MEMBERS_CACHE_TTL_MS', 15 * 60 * 1000),
  guildMembersCacheMaxSize: parsePositiveIntEnv('GUILD_MEMBERS_CACHE_MAX_SIZE', 200),

  /**
   * Adaptive backoff bounds for the deep-scan worker. The worker has
   * no built-in throttle; it relied entirely on concurrency reduction
   * to avoid bible 429s. Adaptive backoff adds a self-regulating per-
   * worker pause: starts at 300ms, grows by 500ms on every null
   * (transient failure) up to the max, shrinks by 100ms on every
   * success back to the floor. Shared across the workers in one scan
   * so all of them slow down together when bible heats up.
   */
  scanBackoffMinMs: parsePositiveIntEnv('SCAN_BACKOFF_MIN_MS', 300),
  scanBackoffMaxMs: parsePositiveIntEnv('SCAN_BACKOFF_MAX_MS', 3000),
  strongholdDeepUseScraperApi: parseBooleanEnv('STRONGHOLD_DEEP_USE_SCRAPERAPI', false),

  /** Lost Ark server status page URL */
  statusUrl: 'https://www.playlostark.com/en-gb/support/server-status',

  /** The server name(s) to monitor (comma-separated, must match names on the status page exactly) */
  targetServers: (process.env.TARGET_SERVERS || process.env.TARGET_SERVER || 'Brelshaza')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Path to the local state file */
  stateFilePath: './data/status.json',
};

export default config;
