import { defineConfig } from "vitest/config";

// End-to-end tests drive the real app (tests/e2e). Run them with `npm run test:e2e`,
// never with `npm test`: they need a built app, tauri-driver and WebKitWebDriver.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // One DeskNotes at a time: a second copy would hand over to the first.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
