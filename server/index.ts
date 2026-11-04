import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";

// Only listen on this machine. Set HOST=0.0.0.0 only if you really want the API
// (and your API key's budget) reachable from other devices on the network.
const HOST = process.env.HOST ?? "127.0.0.1";
// API_PORT (not PORT) so tools that set PORT for the web server don't collide with it.
const PORT = Number(process.env.API_PORT ?? 3001);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5180);

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ??
    [WEB_PORT, PORT].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const app = createApp({
  allowedOrigins,
  staticDir: fileURLToPath(new URL("../dist/", import.meta.url)),
});

app.listen(PORT, HOST, () => {
  console.log(`Triage API listening on http://${HOST}:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY is not set. Triage calls will fail until you add it to .env");
  }
});
