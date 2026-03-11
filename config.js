/**
 * config.js
 * Loads and validates all environment variables from .env file.
 * Centralizes configuration so no sensitive data is hardcoded.
 */

import 'dotenv/config';

/**
 * Parse and validate a required environment variable.
 * Throws a clear error if the variable is missing.
 * @param {string} key - The environment variable name
 * @returns {string}
 */
function requireEnv(key) {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

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
