import express from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fromModule } from "./paths.ts";
import type { Ticket, TriageResult } from "../shared/schema.ts";
import { triageTicket as realTriageTicket, previewPrompt } from "./triage.ts";
import { DEFAULT_MODEL, findModel, type ModelOption } from "../shared/models.ts";

export interface AppOptions {
  /** Origins allowed to call the API from a browser. Requests without an Origin header are allowed. */
  allowedOrigins: Set<string>;
  /** Swap in a fake in tests so nothing is billed. */
  triageTicket?: typeof realTriageTicket;
  /** Returns the current tickets. Defaults to server/tickets.json, re-read when it changes. */
  loadTickets?: () => Ticket[];
  /** How many tickets to send to the API at once during "Triage all". */
  concurrency?: number;
  /** Cap on single-ticket calls in flight, so repeated clicks can't run up a bill. */
  maxSingleInFlight?: number;
  /** Folder with the built UI to serve, if any. */
  staticDir?: string;
}

const TICKETS_FILE = fromModule(import.meta.url, "./tickets.json");
let ticketCache: { mtime: number; tickets: Ticket[] } | undefined;

/** Reads tickets.json, re-reading it only when the file changes. */
export function loadTicketsFromDisk(): Ticket[] {
  const mtime = statSync(TICKETS_FILE).mtimeMs;
  if (ticketCache?.mtime !== mtime) {
    ticketCache = { mtime, tickets: JSON.parse(readFileSync(TICKETS_FILE, "utf8")) };
  }
  return ticketCache.tickets;
}

export function createApp({
  allowedOrigins,
  triageTicket = realTriageTicket,
  loadTickets = loadTicketsFromDisk,
  concurrency = 4,
  maxSingleInFlight = 4,
  staticDir,
}: AppOptions) {
  const app = express();
  const findTicket = (id: string) => loadTickets().find((t) => t.id === id);

  // The model comes from ?model=<id>. Only ids in shared/models.ts are allowed.
  function modelFrom(req: express.Request, res: express.Response): ModelOption | undefined {
    const id = typeof req.query.model === "string" ? req.query.model : DEFAULT_MODEL;
    const model = findModel(id);
    if (!model) res.status(400).json({ status: "error", error: `Unknown model: ${id}` });
    return model;
  }

  // RAG is on unless ?rag=0.
  const ragFrom = (req: express.Request) => req.query.rag !== "0";

  // Browsers send an Origin header on cross-site requests. Only our own pages may call the API.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return void res.status(403).json({ status: "error", error: `Origin not allowed: ${origin}` });
    }
    next();
  });

  app.get("/api/tickets", (_req, res) => {
    res.json(loadTickets());
  });

  // Shows exactly what will be sent for one ticket. Free: nothing is sent to the API.
  app.get("/api/tickets/:id/prompt", (req, res) => {
    const ticket = findTicket(req.params.id);
    if (!ticket) return void res.status(404).json({ status: "error", error: "Unknown ticket" });
    const model = modelFrom(req, res);
    if (model) res.json(previewPrompt(ticket, model, ragFrom(req)));
  });

  // Triage a single ticket. Paid: one API call.
  let singleInFlight = 0;
  app.post("/api/tickets/:id/triage", async (req, res) => {
    const ticket = findTicket(req.params.id);
    if (!ticket) return void res.status(404).json({ status: "error", error: "Unknown ticket" });
    const model = modelFrom(req, res);
    if (!model) return;
    if (singleInFlight >= maxSingleInFlight) {
      return void res
        .status(429)
        .json({ status: "error", error: "Too many triage calls in progress. Wait for one to finish." });
    }
    singleInFlight++;
    try {
      res.json(await triageTicket(ticket, model, { useRag: ragFrom(req) }));
    } finally {
      singleInFlight--;
    }
  });

  // Triage the whole queue. Paid: one API call per ticket. It's a POST, so a link,
  // prefetch or page on another site can't start it. Results stream back as
  // Server-Sent Events, one event per ticket, as soon as each API call finishes.
  let batchRunning = false;
  app.post("/api/triage-all", async (req, res) => {
    const model = modelFrom(req, res);
    if (!model) return;
    if (batchRunning) {
      return void res.status(409).json({ status: "error", error: "A batch is already running." });
    }
    batchRunning = true;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    res.on("close", () => (closed = true));
    const send = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const useRag = ragFrom(req);
      const queue = [...loadTickets()];
      const runNext = async () => {
        const ticket = queue.shift()!;
        send("started", { ticketId: ticket.id });
        const result: TriageResult = await triageTicket(ticket, model, { useRag });
        send("result", result);
      };
      const worker = async () => {
        while (queue.length && !closed) await runNext();
      };

      // Run the first ticket alone so it writes the prompt cache. If several requests
      // started at once, each would miss the cache and pay to write it.
      if (queue.length && !closed) await runNext();
      await Promise.all(Array.from({ length: concurrency }, worker));
      send("done", {});
    } finally {
      batchRunning = false;
      res.end();
    }
  });

  // After `npm run build`, the server can serve the UI itself (`npm start`).
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile("index.html", { root: staticDir }));
  }

  return app;
}
