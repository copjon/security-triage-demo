import type { TriageResult } from "../shared/schema.ts";
import { CHECKS, type Check, type TicketScore } from "./score.ts";

/** The shape eval/run.ts writes to eval/results/*.json. */
export interface SavedRun {
  model: string;
  effort: string;
  useRag: boolean;
  promptVersion?: string;
  startedAt?: string;
  wallMs?: number;
  costUsd?: number;
  summary: { pass: number; total: number; rate: number; byCheck: Record<Check, { pass: number; total: number }> };
  scores: TicketScore[];
  results: TriageResult[];
}

export interface ModelStats {
  key: string; // model · effort · RAG
  model: string;
  effort: string;
  rag: boolean;
  runs: number;
  accuracy: { mean: number; min: number; max: number };
  perfectRuns: number;
  byCheck: Record<Check, { pass: number; total: number }>;
  costPerRun: number;
  costPerTicket: number;
  costPerCorrectCheck: number;
  avgLatencyMs: number;
  avgWallMs: number;
  avgOutputTokens: number;
  cacheReadShare: number;
  errors: number;
  /** Ticket id -> how many runs missed it, and which checks. */
  misses: Record<string, { runs: number; checks: string[] }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Group saved runs by model, effort and RAG, and compute accuracy, cost and speed. Pure. */
export function aggregate(runs: SavedRun[]): ModelStats[] {
  const groups = new Map<string, SavedRun[]>();
  for (const r of runs) {
    const key = `${r.model} · effort ${r.effort} · RAG ${r.useRag ? "on" : "off"}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const rates = group.map((r) => r.summary.rate);
    const byCheck = Object.fromEntries(CHECKS.map((c) => [c, { pass: 0, total: 0 }])) as ModelStats["byCheck"];
    const misses: ModelStats["misses"] = {};
    const metrics = group.flatMap((r) => r.results.flatMap((x) => ("metrics" in x && x.metrics ? [x.metrics] : [])));
    let errors = 0;

    for (const r of group) {
      for (const c of CHECKS) {
        byCheck[c].pass += r.summary.byCheck[c]?.pass ?? 0;
        byCheck[c].total += r.summary.byCheck[c]?.total ?? 0;
      }
      for (const s of r.scores) {
        if (!s.failed.length) continue;
        const m = (misses[s.ticketId] ??= { runs: 0, checks: [] });
        m.runs++;
        for (const f of s.failed) if (!m.checks.includes(f.check)) m.checks.push(f.check);
      }
      for (const x of r.results) {
        if (x.status === "error") {
          errors++;
          const m = (misses[x.ticketId] ??= { runs: 0, checks: [] });
          m.runs++;
          if (!m.checks.includes("error")) m.checks.push("error");
        }
      }
    }

    const costs = group.map((r) => r.costUsd ?? r.results.reduce((n, x) => n + ("metrics" in x && x.metrics ? x.metrics.estCostUsd : 0), 0));
    const tickets = group.reduce((n, r) => n + r.results.length, 0);
    const correct = group.reduce((n, r) => n + r.summary.pass, 0);
    const input = metrics.reduce((n, m) => n + m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens, 0);

    return {
      key,
      model: group[0].model,
      effort: group[0].effort,
      rag: group[0].useRag,
      runs: group.length,
      accuracy: { mean: mean(rates), min: Math.min(...rates), max: Math.max(...rates) },
      perfectRuns: rates.filter((r) => r === 1).length,
      byCheck,
      costPerRun: mean(costs),
      costPerTicket: tickets ? costs.reduce((a, b) => a + b, 0) / tickets : 0,
      costPerCorrectCheck: correct ? costs.reduce((a, b) => a + b, 0) / correct : 0,
      avgLatencyMs: mean(metrics.map((m) => m.latencyMs)),
      avgWallMs: mean(group.flatMap((r) => (r.wallMs ? [r.wallMs] : []))),
      avgOutputTokens: mean(metrics.map((m) => m.outputTokens)),
      cacheReadShare: input ? metrics.reduce((n, m) => n + m.cacheReadTokens, 0) / input : 0,
      errors,
      misses,
    };
  });
}
