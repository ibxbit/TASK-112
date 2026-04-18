import { defineConfig, devices } from "@playwright/experimental-ct-react";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: "on-first-retry",
    headless: true,
    viewport: { width: 1280, height: 720 },
    ctPort: 3100,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
