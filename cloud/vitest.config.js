import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { BOT_TOKEN: "test-bot-token" } },
    }),
  ],
  test: {
    setupFiles: ["test/setup.js"],
  },
});
