import { describe, expect, it } from "vitest";
import { aggregate, type SavedRun } from "../../eval/aggregate.ts";
import { CHECKS } from "../../eval/score.ts";
import type { TriageMetrics, TriageResult } from "../../shared/schema.ts";
import { sampleTriage } from "../helpers.ts";

const metrics = (cost: number, latencyMs: number): TriageMetrics => ({
  model: "m",
  latencyMs,
  inputTokens: 100,
  outputTokens: 500,
  cacheWriteTokens: 0,
  cacheReadTokens: 900,
  estCostUsd: cost,
  fallbackUsed: false,
});

const byCheck = (pass: number, total: number) =>
  Object.fromEntries(CHECKS.map((c) => [c, c === "risk_level" ? { pass, total } : { pass: 1, total: 1 }])) as SavedRun["summary"]["byCheck"];

function run(model: string, rate: number, failedTicket?: string): SavedRun {
  const results: TriageResult[] = [
    { ticketId: "A", status: "ok", config: { model, rag: true, effort: "low" }, triage: sampleTriage(), retrieved: [], metrics: metrics(0.01, 1000) },
    { ticketId: "B", status: "ok", config: { model, rag: true, effort: "low" }, triage: sampleTriage(), retrieved: [], metrics: metrics(0.01, 3000) },
  ];
  return {
    model,
    effort: "low",
    useRag: true,
    costUsd: 0.02,
    wallMs: 5000,
    summary: { pass: rate * 10, total: 10, rate, byCheck: byCheck(rate === 1 ? 2 : 1, 2) },
    scores: [
      { ticketId: "A", passed: ["risk_level"], failed: [] },
      { ticketId: "B", passed: [], failed: failedTicket ? [{ check: "risk_level", expected: "high", got: "low" }] : [] },
    ],
    results,
  };
}

describe("aggregate", () => {
  it("groups runs by model and averages accuracy, cost and latency", () => {
    const [s] = aggregate([run("x", 1), run("x", 0.9, "B"), run("x", 0.8, "B")]);
    expect(s.runs).toBe(3);
    expect(s.accuracy.mean).toBeCloseTo(0.9);
    expect(s.accuracy.min).toBe(0.8);
    expect(s.perfectRuns).toBe(1);
    expect(s.costPerRun).toBeCloseTo(0.02);
    expect(s.costPerTicket).toBeCloseTo(0.01);
    expect(s.avgLatencyMs).toBe(2000);
    expect(s.cacheReadShare).toBeCloseTo(0.9);
  });

  it("counts how often each ticket was missed", () => {
    const [s] = aggregate([run("x", 1), run("x", 0.9, "B"), run("x", 0.8, "B")]);
    expect(s.misses).toEqual({ B: { runs: 2, checks: ["risk_level"] } });
  });

  it("keeps different models apart", () => {
    expect(aggregate([run("x", 1), run("y", 1)]).map((s) => s.model).sort()).toEqual(["x", "y"]);
  });

  it("sums per-check totals across runs", () => {
    const [s] = aggregate([run("x", 1), run("x", 0.9, "B")]);
    expect(s.byCheck.risk_level).toEqual({ pass: 3, total: 4 });
  });
});
