/**
 * Score the triage prompt against eval/expected.json. PAID: one API call per ticket.
 *
 *   npm run eval -- --model claude-haiku-5-5 --effort low --rag on
 *
 * Flags: --model <id> (default Opus 5.5), --effort low|medium|high|xhigh|max (default low),
 * --rag on|off (default on), --only SEC-101,SEC-118 (subset), --yes (skip the cost prompt).
 * Results are written to eval/results/<timestamp>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, findModel } from "../shared/models.ts";
import type { Effort, TriageResult } from "../shared/schema.ts";
import { loadTicketsFromDisk } from "../server/app.ts";
import { PROMPT_VERSION, triageTicket } from "../server/triage.ts";
import { scoreTicket, summarize, type Expected, type TicketScore } from "./score.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    effort: { type: "string", default: "low" },
    rag: { type: "string", default: "on" },
    only: { type: "string" },
    yes: { type: "boolean", default: false },
  },
});

const model = findModel(values.model);
if (!model) throw new Error(`Unknown model: ${values.model}`);
const effort = values.effort as Effort;
const useRag = values.rag !== "off";

const expected: Record<string, Expected> = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const only = values.only?.split(",").map((s) => s.trim());
const tickets = loadTicketsFromDisk().filter((t) => expected[t.id] && (!only || only.includes(t.id)));

// Rough upper bound so nobody starts a paid run by accident: ~4K input + ~1K output per ticket, uncached.
const estimate = tickets.length * (4000 * model.price.input + 1000 * model.price.output) / 1_000_000;
console.log(`${tickets.length} tickets on ${model.label}, effort ${effort}, RAG ${useRag ? "on" : "off"}, prompt ${PROMPT_VERSION}. Up to ~${estimate.toFixed(2)}.`);
if (!values.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Run it? [y/N] ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") process.exit(0);
}

const startedAt = new Date();
// First ticket alone to write the prompt cache, then 4 at a time.
const results: TriageResult[] = [];
const queue = [...tickets];
const runNext = async () => {
  const t = queue.shift()!;
  results.push(await triageTicket(t, model, { useRag, effort }));
};
if (queue.length) await runNext();
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await runNext(); }));

const scores: TicketScore[] = [];
let cost = 0;
for (const r of results.sort((a, b) => a.ticketId.localeCompare(b.ticketId))) {
  if ("metrics" in r && r.metrics) cost += r.metrics.estCostUsd;
  if (r.status !== "ok") {
    console.log(`${r.ticketId}  ERROR  ${r.error}`);
    continue;
  }
  const s = scoreTicket(r.ticketId, expected[r.ticketId], r.triage, r.retrieved);
  scores.push(s);
  const fails = s.failed.map((f) => `${f.check}: expected ${f.expected}, got ${f.got}`).join("; ");
  console.log(`${r.ticketId}  ${s.failed.length ? "FAIL" : "pass"}  ${fails}`);
}

const summary = summarize(scores);
console.log("\nPer check:");
for (const [check, { pass, total }] of Object.entries(summary.byCheck)) console.log(`  ${check.padEnd(13)} ${pass}/${total}`);
console.log(`\nOverall ${summary.pass}/${summary.total} (${(summary.rate * 100).toFixed(0)}%). Errors: ${results.length - scores.length}. Cost ~$${cost.toFixed(3)}.`);

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
const wallMs = Date.now() - startedAt.getTime();
writeFileSync(
  file,
  JSON.stringify(
    { model: model.id, effort, useRag, promptVersion: PROMPT_VERSION, startedAt, wallMs, costUsd: cost, summary, scores, results },
    null,
    2,
  ),
);
console.log(`Saved ${file.pathname}`);
