import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    browserName: "chromium",
    headless: true,
    channel: process.env.CI ? undefined : "chrome",
  },
  reporter: "list",
  webServer: {
    command: "pnpm dev:web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
