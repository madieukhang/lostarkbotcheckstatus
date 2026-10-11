/**
 * cloud/src/botGuilds.js
 * Lists the guilds the LoaLogs bot is in, for the gateway's login rule (only members of a
 * guild with the bot may sign in). The list is kept for five minutes at module level: plain
 * data may outlive a request in Workers, while sockets and clients may not.
 */

const DISCORD_API = "https://discord.com/api/v10";
const PAGE_SIZE = 200;
const CACHE_MS = 5 * 60 * 1000;

let cache = null;

function discordUnavailable(cause) {
  const error = new Error("Discord guild list unavailable", { cause });
  error.name = "DiscordUnavailable";
  return error;
}

async function fetchPage(env, after, fetchImpl) {
  const url = new URL(`${DISCORD_API}/users/@me/guilds`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (after) url.searchParams.set("after", after);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bot ${env.BOT_TOKEN}` } });
    if (!res.ok) throw new Error(`Discord answered HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || !page.every((guild) => typeof guild?.id === "string")) {
      throw new Error("Discord sent a guild page that is not a list of guilds");
    }
    return page;
  } catch (err) {
    throw discordUnavailable(err);
  }
}

/**
 * @param {{ BOT_TOKEN: string }} env Worker env holding the LoaLogs bot token.
 * @param {number} [now=Date.now()] Current time in ms, for the cache window.
 * @param {typeof fetch} [fetchImpl=fetch] Fetch implementation.
 * @returns {Promise<string[]>} Ids of every guild the bot is in.
 * @throws {Error} named "DiscordUnavailable" on a network error, non-2xx answer or bad body.
 */
export async function getBotGuildIds(env, now = Date.now(), fetchImpl = fetch) {
  if (cache && now < cache.expiresAt) return cache.ids;
  const ids = [];
  let after = null;
  for (;;) {
    const page = await fetchPage(env, after, fetchImpl);
    for (const guild of page) ids.push(guild.id);
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1].id;
  }
  cache = { ids, expiresAt: now + CACHE_MS };
  return ids;
}

/**
 * Drops the cached guild list. Only tests call this: the cache is module state that
 * nothing else can reach between test cases.
 * @returns {void}
 */
export function clearBotGuildCache() {
  cache = null;
}
