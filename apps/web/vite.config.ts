import { defineConfig } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

const api = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/v1": api, "/api/auth": api },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // A test can wait on several find* calls (5 s each, see setup.ts); the 5 s default cut them off on slow CI.
    testTimeout: 20_000,
  },
});
