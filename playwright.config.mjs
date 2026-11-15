import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.mjs",
  use: { baseURL: "http://localhost:8091" },
  webServer: {
    command: "node app/hub/server.mjs --port 8091 --data test-results/hub-data --reset",
    url: "http://localhost:8091",
    reuseExistingServer: false,
  },
});
