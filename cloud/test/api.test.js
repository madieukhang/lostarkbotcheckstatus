import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { DISCORD_GUILDS_URL, guildPage, network } from "./network.js";

const BASE = "https://loalogs-api";

function idRange(first, last) {
  const ids = [];
  for (let id = first; id <= last; id += 1) ids.push(String(id));
  return ids;
}

describe("GET /api/whoami", () => {
  it("echoes the gateway identity", async () => {
    const user = { uid: "1", name: "A", guilds: ["g1"], lang: "vi" };
    const res = await exports.default.fetch(`${BASE}/api/whoami`, {
      headers: { "x-web-user": JSON.stringify(user) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: user });
  });

  it("is 401 without a usable identity", async () => {
    const headerSets = [{}, { "x-web-user": "not json" }, { "x-web-user": '{"name":"A"}' }];
    for (const headers of headerSets) {
      const res = await exports.default.fetch(`${BASE}/api/whoami`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: { code: "noIdentity" } });
    }
  });
});

describe("GET /internal/bot-guilds", () => {
  it("pages through Discord with the bot token", async () => {
    const requests = [];
    network.use(
      http.get(DISCORD_GUILDS_URL, ({ request }) => {
        const url = new URL(request.url);
        requests.push({
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
          auth: request.headers.get("authorization"),
        });
        const after = url.searchParams.get("after");
        if (after === null) return HttpResponse.json(guildPage(idRange(100, 299)));
        if (after === "299") return HttpResponse.json(guildPage(["300"]));
        return HttpResponse.json([], { status: 400 });
      }),
    );

    const res = await exports.default.fetch(`${BASE}/internal/bot-guilds`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.guildIds).toHaveLength(201);
    expect(body.data.guildIds[0]).toBe("100");
    expect(body.data.guildIds[200]).toBe("300");
    expect(requests).toEqual([
      { after: null, limit: "200", auth: "Bot test-bot-token" },
      { after: "299", limit: "200", auth: "Bot test-bot-token" },
    ]);
  });

  it("maps a malformed Discord page to 503", async () => {
    for (const body of [{ message: "x" }, null, "str", [{ name: "no id" }]]) {
      network.use(http.get(DISCORD_GUILDS_URL, () => HttpResponse.json(body)));
      const res = await exports.default.fetch(`${BASE}/internal/bot-guilds`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: { code: "discordUnavailable" } });
    }
  });

  it("maps a Discord failure to 503", async () => {
    const failures = [
      () => new HttpResponse(null, { status: 502 }),
      () => HttpResponse.json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, { status: 429 }),
      () => HttpResponse.error(),
    ];
    for (const failure of failures) {
      network.use(http.get(DISCORD_GUILDS_URL, failure));
      const res = await exports.default.fetch(`${BASE}/internal/bot-guilds`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: { code: "discordUnavailable" } });
    }
  });
});

describe("routing", () => {
  it("is 404 for an unknown path or method", async () => {
    const cases = [
      [`${BASE}/api/nope`, "GET"],
      [`${BASE}/api/whoami`, "POST"],
      [`${BASE}/internal/bot-guilds`, "DELETE"],
    ];
    for (const [url, method] of cases) {
      const res = await exports.default.fetch(url, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: { code: "notFound" } });
    }
  });
});
