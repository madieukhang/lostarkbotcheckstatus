import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import { getBotGuildIds } from "../src/botGuilds.js";
import { DISCORD_GUILDS_URL, guildPage, network } from "./network.js";

const env = { BOT_TOKEN: "test-bot-token" };

it("keeps the guild list for five minutes", async () => {
  let hits = 0;
  network.use(
    http.get(DISCORD_GUILDS_URL, () => {
      hits += 1;
      return HttpResponse.json(guildPage(["1"]));
    }),
  );
  const t = 1_000_000;

  expect(await getBotGuildIds(env, t)).toEqual(["1"]);
  expect(await getBotGuildIds(env, t + 299_000)).toEqual(["1"]);
  expect(hits).toBe(1);

  expect(await getBotGuildIds(env, t + 301_000)).toEqual(["1"]);
  expect(hits).toBe(2);
});

it("does not keep a failed read", async () => {
  network.use(http.get(DISCORD_GUILDS_URL, () => new HttpResponse(null, { status: 500 })));
  await expect(getBotGuildIds(env, 1_000_000)).rejects.toMatchObject({ name: "DiscordUnavailable" });

  network.use(http.get(DISCORD_GUILDS_URL, () => HttpResponse.json(guildPage(["7"]))));
  expect(await getBotGuildIds(env, 1_000_001)).toEqual(["7"]);
});
