import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Keep in sync with server/index.ts: both read API_PORT and WEB_PORT.
const apiPort = Number(process.env.API_PORT ?? 3001);
const webPort = Number(process.env.WEB_PORT ?? 5180);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    // Forward API calls to the Express server so the browser never sees the API key.
    // 127.0.0.1, not localhost: the API only listens on IPv4 loopback.
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
