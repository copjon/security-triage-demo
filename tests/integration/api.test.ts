/**
 * Integration: the real Express app over HTTP, with the real triage pipeline and
 * retrieval, and a fake Anthropic client so nothing is billed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../../server/app.ts";
import { triageTicket } from "../../server/triage.ts";
import { parseSse } from "../../src/api.ts";
import { deferred, fakeClient, listen, TICKETS, type FakeReply, type ParseParams } from "../helpers.ts";

const ORIGIN = "http://localhost:5180";
let server: Awaited<ReturnType<typeof listen>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(reply?: (p: ParseParams) => FakeReply | Promise<FakeReply>, opts: Partial<AppOptions> = {}) {
  const fake = fakeClient();
  const calls: ParseParams[] = [];
  const order: string[] = [];
  const app = createApp({
    allowedOrigins: new Set([ORIGIN]),
    loadTickets: () => TICKETS,
    triageTicket: async (ticket, model, options) => {
      order.push(`start:${ticket.id}`);
      const client = {
        beta: {
          messages: {
            create: async (params: ParseParams) => {
              calls.push(params);
              if (reply) {
                const r = await reply(params);
                if (r.throws) throw r.throws;
              }
              return (fake.client.beta.messages.create as unknown as (p: ParseParams) => Promise<unknown>)(params);
            },
          },
        },
      } as unknown as NonNullable<Parameters<typeof triageTicket>[2]>["client"];
      const result = await triageTicket(ticket, model, { ...options, client });
      order.push(`end:${ticket.id}`);
      return result;
    },
    ...opts,
  });
  server = await listen(app);
  return { url: server.url, calls, order };
}

describe("read-only endpoints", () => {
  it("lists tickets", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/tickets`);
    expect(res.status).toBe(200);
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("previews the prompt with retrieval, without calling the model", async () => {
    const { url, calls } = await start();
    const on = await (await fetch(`${url}/api/tickets/T-1/prompt?rag=1`)).json();
    const off = await (await fetch(`${url}/api/tickets/T-1/prompt?rag=0`)).json();
    expect(on.retrieved.map((c: { id: string }) => c.id)).toContain("vendor-register#textflare-sms-messaging");
    expect(on.user).toContain("<context>");
    expect(off.retrieved).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns 404 for an unknown ticket and 400 for an unknown model", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/api/tickets/NOPE/prompt`)).status).toBe(404);
    const bad = await fetch(`${url}/api/tickets/T-1/triage?model=gpt-4`, { method: "POST" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ status: "error", error: "Unknown model: gpt-4" });
  });
});

describe("origin check", () => {
  it("blocks requests from other sites before anything is billed", async () => {
    const { url, calls } = await start();
    const res = await fetch(`${url}/api/tickets/T-1/triage`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("allows the app's own origin", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/tickets/T-1/triage`, { method: "POST", headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
  });
});

describe("single-ticket triage", () => {
  it("passes the model and RAG choice through to the request", async () => {
    const { url, calls } = await start();
    const r = await (await fetch(`${url}/api/tickets/T-1/triage?model=claude-haiku-5-5&rag=0`, { method: "POST" })).json();
    expect(r).toMatchObject({ status: "ok", config: { model: "claude-haiku-5-5", rag: false } });
    expect(calls[0].model).toBe("claude-haiku-5-5");
    expect(calls[0].messages[0].content).not.toContain("<context>");
  });

  it("caps calls in flight with 429", async () => {
    const hold = deferred();
    const { url } = await start(async () => (await hold.promise, {}), { maxSingleInFlight: 1 });
    const first = fetch(`${url}/api/tickets/T-1/triage`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(`${url}/api/tickets/T-2/triage`, { method: "POST" });
    expect(second.status).toBe(429);
    hold.resolve();
    expect((await first).status).toBe(200);
  });

  it("returns API failures as error results", async () => {
    const { url } = await start(() => ({ throws: new Error("overloaded") }));
    const r = await (await fetch(`${url}/api/tickets/T-1/triage`, { method: "POST" })).json();
    expect(r).toMatchObject({ ticketId: "T-1", status: "error", error: "overloaded" });
  });
});

async function readStream(res: Response) {
  const text = await res.text();
  return parseSse(text).events.map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

describe("batch triage", () => {
  it("is not available over GET, so links and prefetch can't start a paid run", async () => {
    const { url, calls } = await start();
    expect((await fetch(`${url}/api/triage-all`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("streams a started and result event per ticket, then done", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/api/triage-all?model=claude-haiku-5-5`, { method: "POST" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readStream(res);
    expect(events.filter((e) => e.event === "started")).toHaveLength(3);
    const results = events.filter((e) => e.event === "result").map((e) => e.data);
    expect(results.map((r) => r.ticketId).sort()).toEqual(["T-1", "T-2", "T-3"]);
    expect(results.every((r) => r.status === "ok" && r.config.model === "claude-haiku-5-5")).toBe(true);
    expect(events.at(-1)?.event).toBe("done");
  });

  it("finishes the first ticket before starting the rest, so they hit the prompt cache", async () => {
    const { url, order } = await start();
    await readStream(await fetch(`${url}/api/triage-all`, { method: "POST" }));
    expect(order.slice(0, 2)).toEqual(["start:T-1", "end:T-1"]);
  });

  it("refuses a second batch while one is running", async () => {
    const hold = deferred();
    const { url } = await start(async () => (await hold.promise, {}));
    const first = fetch(`${url}/api/triage-all`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(`${url}/api/triage-all`, { method: "POST" });
    expect(second.status).toBe(409);
    hold.resolve();
    await readStream(await first);
    // Once finished, a new batch is allowed again.
    const third = await fetch(`${url}/api/triage-all`, { method: "POST" });
    expect(third.status).toBe(200);
    await third.text();
  });
});
