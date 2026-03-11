/**
 * config.js
 * Loads and validates all environment variables from .env file.
 * Centralizes configuration so no sensitive data is hardcoded.
 */

import 'dotenv/config';

/**
 * Validate all required environment variables up-front.
 * Logs every missing key and exits cleanly so Railway shows a clear error.
 * @param {string[]} keys
 */
function validateEnv(keys) {
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

validateEnv(['DISCORD_TOKEN', 'CHANNEL_ID']);

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

const config = {
  /** Discord bot token */
  token: requireEnv('DISCORD_TOKEN'),

  /** ID of the channel where notifications are sent */
  channelId: requireEnv('CHANNEL_ID'),

  /** ID of the role to mention in notifications */
  // roleId: requireEnv('ROLE_ID'),

  /** How often to check server status (milliseconds) */
  checkIntervalMs: parseInterval(),

  /** Lost Ark server status page URL */
  statusUrl: 'https://www.playlostark.com/en-gb/support/server-status',

  /** The server name to monitor */
  targetServer: 'Brelshaza',

  /** Path to the local state file */
  stateFilePath: './data/status.json',
};

export default config;
