import { describe, expect, it } from "vitest";
import { computeMetrics, describeError } from "../../server/triage.ts";
import { DEFAULT_MODEL, findModel, MODELS } from "../../shared/models.ts";
import { scoreTicket, summarize, type Expected } from "../../eval/score.ts";
import { sampleTriage } from "../helpers.ts";

const opus = findModel("claude-opus-5-5")!;

describe("computeMetrics", () => {
  it("prices uncached input, cache writes, cache reads and output separately", () => {
    const m = computeMetrics(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
      "claude-opus-5-5",
      opus,
      1234,
    );
    // $4 input + $5 cache write + $0.20 cache read + $20 output
    expect(m.estCostUsd).toBeCloseTo(29.2, 6);
    expect(m.latencyMs).toBe(1234);
  });

  it("treats missing cache fields as zero", () => {
    const m = computeMetrics({ input_tokens: 100, output_tokens: 10 }, "x", opus, 0);
    expect(m.cacheReadTokens).toBe(0);
    expect(m.cacheWriteTokens).toBe(0);
  });

  it("detects a fallback model from usage iterations", () => {
    const m = computeMetrics(
      { input_tokens: 1, output_tokens: 1, iterations: [{ type: "message" }, { type: "fallback_message" }] },
      "x",
      opus,
      0,
    );
    expect(m.fallbackUsed).toBe(true);
  });
});

describe("models", () => {
  it("defaults to Opus 5.5", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
  });

  it("rejects unknown ids", () => {
    expect(findModel("gpt-4")).toBeUndefined();
    expect(findModel(undefined)).toBeUndefined();
  });

  it("only sends server-side fallback where it's offered", () => {
    expect(MODELS.find((m) => m.id === "claude-haiku-5-5")!.supportsFallback).toBe(false);
  });

  it("has cache reads cheaper than input for every model", () => {
    for (const m of MODELS) expect(m.price.cacheRead).toBeLessThan(m.price.input);
  });
});

describe("describeError", () => {
  it("explains a missing API key", () => {
    expect(describeError(new Error("Could not resolve authentication method."))).toMatch(/No API key found/);
  });

  it("passes other messages through", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("scoreTicket", () => {
  const expected: Expected = { risk_level: ["high"], hipaa: true, cross_tenant: null, owner: ["GRC"], injection: false };

  it("passes when every label matches and skips null checks", () => {
    const s = scoreTicket(
      "T",
      expected,
      sampleTriage({ risk_level: "high", hipaa: { applies: true, concerns: [] }, recommended_owner: "GRC" }),
      null,
    );
    expect(s.failed).toEqual([]);
    expect(s.passed).not.toContain("cross_tenant");
  });

  it("reports what was expected and what came back", () => {
    const s = scoreTicket("T", expected, sampleTriage({ risk_level: "low", recommended_owner: "GRC" }), null);
    expect(s.failed).toContainEqual({ check: "risk_level", expected: "high", got: "low" });
    expect(s.failed).toContainEqual({ check: "hipaa", expected: "true", got: "false" });
  });

  it("fails citations that weren't in the retrieved context", () => {
    const s = scoreTicket(
      "T",
      expected,
      sampleTriage({ risk_level: "high", hipaa: { applies: true, concerns: [] }, recommended_owner: "GRC", policy_refs: [{ doc_id: "made-up#x", how_used: "" }] }),
      [],
    );
    expect(s.failed.map((f) => f.check)).toEqual(["citations"]);
  });

  it("summarizes pass rates per check", () => {
    const a = scoreTicket("A", expected, sampleTriage({ risk_level: "high", hipaa: { applies: true, concerns: [] }, recommended_owner: "GRC" }), null);
    const b = scoreTicket("B", expected, sampleTriage({ risk_level: "low", hipaa: { applies: true, concerns: [] }, recommended_owner: "GRC" }), null);
    const sum = summarize([a, b]);
    expect(sum.byCheck.risk_level).toEqual({ pass: 1, total: 2 });
    expect(sum.byCheck.cross_tenant).toEqual({ pass: 0, total: 0 });
  });
});
