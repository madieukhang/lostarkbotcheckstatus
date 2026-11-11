/**
 * bot/app/discord-rest-agent.js
 * The undici Agent the Discord client sends its REST requests through.
 */

import { createRequire } from 'node:module';

// discord.js sends REST requests with undici 6's request(), which uses the
// process-wide dispatcher when it is given none. On Node 24, loading jsdom
// lets its undici 8 take that dispatcher, and undici 8 rejects the FormData
// discord.js builds, so every upload with a file fails (UND_ERR_INVALID_ARG).
// The undici is resolved along discord.js -> @discordjs/rest, so the Agent
// belongs to the same copy that builds and sends the request.
const discordRequire = createRequire(import.meta.resolve('discord.js'));
const restRequire = createRequire(discordRequire.resolve('@discordjs/rest'));

/**
 * @returns {import('undici').Agent} a new Agent of the undici @discordjs/rest uses
 */
export function createDiscordRestAgent() {
  const { Agent } = restRequire('undici');
  return new Agent();
}
