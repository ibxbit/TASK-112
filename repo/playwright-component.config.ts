import { defineConfig, devices } from "@playwright/experimental-ct-react";

export default defineConfig({
  testDir: "./tests/component",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: "on-first-retry",
    headless: true,
    viewport: { width: 1280, height: 720 },
    ctPort: 3200,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
