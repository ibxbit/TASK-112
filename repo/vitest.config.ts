import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "unit_tests/**/*.test.ts",
      "unit_tests/**/*.test.tsx",
      "API_tests/**/*.test.ts",
    ],
    environmentMatchGlobs: [
      ["unit_tests/**/*.test.tsx", "jsdom"],
    ],
  },
});
