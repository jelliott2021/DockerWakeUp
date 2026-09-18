import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive a real Chromium through the wake page. The proxy and
 * its throwaway services are started once by test/e2e/global-setup.ts;
 * `*.test.local` is mapped to 127.0.0.1 inside the browser so host-based
 * routing is exercised exactly as it is behind a reverse proxy.
 */
export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    launchOptions: { args: ["--host-resolver-rules=MAP *.test.local 127.0.0.1"] },
    trace: "retain-on-failure",
  },
});
