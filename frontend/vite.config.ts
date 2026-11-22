/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser talks only to our backend (proxied in dev); never to Kotak Neo.
const BACKEND = process.env.NSE_BACKEND_URL ?? "http://127.0.0.1:8000";

/**
 * Stable file names between deploys. Without this the shared modules lived in the entry file, whose name changes with every build (it lists the names of every lazy
 * page), so every page that imports a shared module got a new name on every deploy: about 25 files and 2.3 MB for a one-line change, kept for days on the server.
 * Libraries and the app's shared code go in chunks that change only when their own code changes.
 */
export function chunkFor(id: string): string | undefined {
  const n = id.split("\\").join("/");
  if (n.includes("/node_modules/")) {
    if (/\/node_modules\/(echarts|zrender)\//.test(n)) return "vendor-echarts";
    if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|@remix-run)\//.test(n)) return "vendor-react";
    if (/\/node_modules\/@tanstack\//.test(n)) return "vendor-query";
    return undefined;
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
      "/ws": { target: BACKEND, ws: true, changeOrigin: false },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900, rollupOptions: { output: { manualChunks: chunkFor } } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    testTimeout: 20000, // the first render of a code-split page compiles its chunk, which is slow when many test files run at once
  },
});
