/**
 * cloud/test/network.js
 * Shared outbound-request mock (msw) and Discord fixtures for the API tests.
 */
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();

export const DISCORD_GUILDS_URL = "https://discord.com/api/v10/users/@me/guilds";

/**
 * Builds a page of partial guild objects as GET /users/@me/guilds returns them.
 * @param {string[]} ids Guild ids in ascending order.
 * @returns {object[]} Partial guild objects.
 */
export function guildPage(ids) {
  return ids.map((id) => ({
    id,
    name: `Guild ${id}`,
    icon: null,
    banner: null,
    owner: false,
    permissions: "0",
    features: [],
  }));
}
