/**
 * cloud/src/index.js
 * loalogs-api: the LoaLogs API Worker behind the lostark-web gateway. It has no public route;
 * the gateway reaches it through a Service Binding, owns login, and sends the verified user
 * in x-web-user. /internal/* serves the gateway itself and is never forwarded from the web.
 */

import { getBotGuildIds } from "./botGuilds.js";
import { readWebUser } from "./identity.js";
import { fail, ok } from "./respond.js";

async function botGuilds(request, env) {
  try {
    return ok({ guildIds: await getBotGuildIds(env) });
  } catch (err) {
    if (err.name !== "DiscordUnavailable") throw err;
    console.warn(`[loalogs-api] bot guild list unavailable: ${err.cause?.message ?? err.message}`);
    return fail(503, "discordUnavailable");
  }
}

function whoami(request) {
  const user = readWebUser(request);
  return user ? ok(user) : fail(401, "noIdentity");
}

const ROUTES = new Map([
  ["GET /internal/bot-guilds", botGuilds],
  ["GET /api/whoami", whoami],
]);

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES.get(`${request.method} ${pathname}`);
    return handler ? handler(request, env) : fail(404, "notFound");
  },
};
