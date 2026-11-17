import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The packaged app is served by the local Python server (same origin).
// During development the Vite dev server proxies /api to it.
export default defineConfig({
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8780",
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
