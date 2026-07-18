import { defineConfig, devices } from "@playwright/test";

const appBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const skipWebServer = process.env.THREEFC_SKIP_WEB_SERVER === "1";
const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: appBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: process.env.THREEFC_WEB_SERVER_COMMAND ?? "make dev",
        url: `${appBaseUrl}/health`,
        reuseExistingServer: !isCi,
        timeout: 600_000,
      },
  projects: [
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
