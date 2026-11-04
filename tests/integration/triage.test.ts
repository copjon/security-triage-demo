/**
 * Integration: triageTicket + real retrieval over kb/ + prompt building, with a fake
 * Anthropic client in place of the network. Checks the exact request we send.
 */
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, triageTicket } from "../../server/triage.ts";
import { findModel } from "../../shared/models.ts";
import { fakeClient, sampleTriage, TICKETS } from "../helpers.ts";

const opus = findModel("claude-opus-5-5")!;
const haiku = findModel("claude-haiku-5-5")!;
const smsTicket = TICKETS[0];

describe("triageTicket request", () => {
  it("caches the system prompt and sends the ticket in the user message", async () => {
    const { client, calls } = fakeClient();
    await triageTicket(smsTicket, opus, { client });
    const [req] = calls;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toContain('<ticket id="T-1">');
  });

  it("uses low effort by default and passes an override through", async () => {
    const { client, calls } = fakeClient();
    await triageTicket(smsTicket, opus, { client });
    await triageTicket(smsTicket, opus, { client, effort: "medium" });
    expect(calls.map((c) => c.output_config.effort)).toEqual(["low", "medium"]);
  });

  it("asks for server-side fallback on Opus but not on Haiku", async () => {
    const { client, calls } = fakeClient();
    await triageTicket(smsTicket, opus, { client });
    await triageTicket(smsTicket, haiku, { client });
    expect(calls[0]).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(calls[1].fallbacks).toBeUndefined();
    expect(calls[1].betas).toBeUndefined();
  });

  it("adds retrieved knowledge base excerpts when RAG is on, and none when off", async () => {
    const { client, calls } = fakeClient();
    const on = await triageTicket(smsTicket, opus, { client, useRag: true });
    const off = await triageTicket(smsTicket, opus, { client, useRag: false });
    expect(calls[0].messages[0].content).toContain('<doc id="vendor-register#textflare-sms-messaging"');
    expect(calls[1].messages[0].content).not.toContain("<context>");
    expect(on.status === "ok" && on.retrieved?.length).toBeGreaterThan(0);
    expect(off.status === "ok" && off.retrieved).toBeNull();
  });
});

describe("triageTicket results", () => {
  it("returns the parsed triage, the run settings and metrics", async () => {
    const { client } = fakeClient();
    const r = await triageTicket(smsTicket, opus, { client });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.config).toEqual({ model: "claude-opus-5-5", rag: true, effort: "low" });
    expect(r.metrics.cacheReadTokens).toBe(3000);
    expect(r.metrics.estCostUsd).toBeGreaterThan(0);
    // The fake cites the first excerpt it was given; it must be one we sent.
    expect(r.retrieved!.map((c) => c.id)).toContain(r.triage.policy_refs[0].doc_id);
  });

  it("reports a refusal as an error that still carries billed metrics", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "refusal", parsed_output: null }));
    const r = await triageTicket(smsTicket, opus, { client });
    expect(r).toMatchObject({ status: "error", error: "The model declined to triage this ticket." });
    expect(r.status === "error" && r.metrics?.estCostUsd).toBeGreaterThan(0);
  });

  it("reports a cut-off reply with the stop reason", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "max_tokens", parsed_output: null }));
    const r = await triageTicket(smsTicket, opus, { client });
    expect(r).toMatchObject({ status: "error", error: "The reply was cut off (stop_reason: max_tokens)." });
  });

  it("reports a reply that breaks the schema, naming the bad value and keeping billed metrics", async () => {
    const bad = { ...sampleTriage(), data_sensitivity: "restricted" };
    const { client } = fakeClient(() => ({ rawText: JSON.stringify(bad) }));
    const r = await triageTicket(smsTicket, opus, { client });
    expect(r.status).toBe("error");
    expect(r.status === "error" && r.error).toContain('data_sensitivity: got "restricted"');
    expect(r.status === "error" && r.metrics?.estCostUsd).toBeGreaterThan(0);
  });

  it("turns a thrown client error into an error result instead of throwing", async () => {
    const { client } = fakeClient(() => ({ throws: new Error("socket hang up") }));
    const r = await triageTicket(smsTicket, opus, { client });
    expect(r).toMatchObject({ status: "error", error: "socket hang up", config: { model: "claude-opus-5-5" } });
  });
});
