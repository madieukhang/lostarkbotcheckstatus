/**
 * cloud/src/identity.js
 * Reads the identity the lostark-web gateway attaches after it verifies the session cookie.
 * The gateway drops every client-sent x-web-* header before adding its own, and this Worker
 * has no public route, so the header is trusted here.
 */

/**
 * @param {Request} request Request forwarded by the gateway.
 * @returns {{ uid: string, name: string, guilds: string[], lang: string } | null}
 *   The web user, or null when the header is missing or carries no string uid.
 */
export function readWebUser(request) {
  const raw = request.headers.get("x-web-user");
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed?.uid !== "string") return null;
  const { uid, name, guilds, lang } = parsed;
  return { uid, name, guilds, lang };
}
