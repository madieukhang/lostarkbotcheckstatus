import { afterAll, afterEach, beforeAll } from "vitest";
import { clearBotGuildCache } from "../src/botGuilds.js";
import { network } from "./network.js";

beforeAll(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  clearBotGuildCache();
});
afterAll(() => network.disable());
