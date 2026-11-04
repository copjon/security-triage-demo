import { describe, expect, it } from "vitest";
import { normalizeResult, parseSse } from "../../src/api.ts";
import { configLabel } from "../../src/format.ts";
import { sampleTriage } from "../helpers.ts";

describe("parseSse", () => {
  it("parses complete events and keeps a partial one for later", () => {
    const { events, rest } = parseSse('event: started\ndata: {"ticketId":"A"}\n\nevent: result\ndata: {"tick');
    expect(events).toEqual([{ event: "started", data: '{"ticketId":"A"}' }]);
    expect(rest).toBe('event: result\ndata: {"tick');
  });

  it("joins multi-line data and handles CRLF", () => {
    const { events } = parseSse("event: x\r\ndata: one\r\ndata: two\r\n\r\n");
    expect(events).toEqual([{ event: "x", data: "one\ntwo" }]);
  });

  it("defaults the event name to message", () => {
    expect(parseSse("data: hi\n\n").events[0].event).toBe("message");
  });
});

describe("normalizeResult", () => {
  it("passes ok results through", () => {
    const ok = { ticketId: "A", status: "ok", triage: sampleTriage(), retrieved: null, metrics: {}, config: {} };
    expect(normalizeResult("A", ok)).toBe(ok);
  });

  it("keeps error results, including billed metrics", () => {
    const r = normalizeResult("A", { status: "error", error: "declined", metrics: { estCostUsd: 0.01 } });
    expect(r).toMatchObject({ status: "error", error: "declined", metrics: { estCostUsd: 0.01 } });
  });

  it("turns a bare error body into an error result with the HTTP status", () => {
    expect(normalizeResult("A", { error: "Unknown model" }, 400)).toEqual({
      ticketId: "A",
      status: "error",
      error: "HTTP 400: Unknown model",
    });
  });

  it("never returns something the UI can't render", () => {
    for (const body of [null, "html page", 42, {}, { status: "ok" }]) {
      expect(normalizeResult("A", body).status).toBe("error");
    }
  });
});

describe("configLabel", () => {
  it("shortens the model name and shows the RAG setting", () => {
    expect(configLabel({ model: "claude-haiku-5-5", rag: false, effort: "low" })).toBe("Haiku 5.5 · no RAG");
  });

  it("is empty without a config", () => {
    expect(configLabel(undefined)).toBe("");
  });
});
