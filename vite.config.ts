import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and must see Rust-side errors in the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: {
    target: "safari16", // WebKitGTK 2.4x is roughly Safari 16+ level
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Each test file in its own process: a process reads TZ again when a test sets it
    // (reminderText.test.ts), a worker thread does not.
    pool: "forks",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
