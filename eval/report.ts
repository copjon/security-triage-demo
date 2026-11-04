/**
 * Summarize saved eval runs as Markdown tables. Free: reads eval/results/ only.
 *
 *   npm run eval:report                      # runs made with the current prompt
 *   npm run eval:report -- --prompt all      # every saved run
 *   npm run eval:report -- --prompt 1a2b3c4d # a specific prompt version
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { findModel } from "../shared/models.ts";
import { PROMPT_VERSION } from "../server/triage.ts";
import { aggregate, type SavedRun } from "./aggregate.ts";
import { CHECKS } from "./score.ts";

const { values } = parseArgs({ options: { prompt: { type: "string", default: PROMPT_VERSION } } });
const dir = new URL("./results/", import.meta.url);

let files: string[] = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
} catch {
  console.log("No eval results yet. Run npm run eval first.");
  process.exit(0);
}

const all: SavedRun[] = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
// Only full runs (every ticket), so accuracy and cost per run are comparable.
const runs = all.filter(
  (r) => r.results.length === 20 && (values.prompt === "all" || r.promptVersion === values.prompt),
);
if (!runs.length) {
  console.log(`No full runs for prompt ${values.prompt}.`);
  process.exit(0);
}

const stats = aggregate(runs).sort((a, b) => b.costPerRun - a.costPerRun);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number, d = 3) => `$${x.toFixed(d)}`;
const name = (id: string) => findModel(id)?.label ?? id;

console.log(`Prompt version: ${values.prompt} · ${runs.length} full runs\n`);
console.log("| Model | Runs | Accuracy (mean) | Range | Perfect runs | Cost / run | Cost / ticket | Avg call latency | Avg run time | Errors |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const s of stats) {
  console.log(
    `| ${name(s.model)} | ${s.runs} | ${pct(s.accuracy.mean)} | ${pct(s.accuracy.min)}–${pct(s.accuracy.max)} | ${s.perfectRuns}/${s.runs} | ${usd(s.costPerRun)} | ${usd(s.costPerTicket, 4)} | ${(s.avgLatencyMs / 1000).toFixed(1)}s | ${(s.avgWallMs / 1000).toFixed(0)}s | ${s.errors} |`,
  );
}

console.log("\n| Model | " + CHECKS.join(" | ") + " |");
console.log("|---|" + CHECKS.map(() => "---").join("|") + "|");
for (const s of stats) {
  console.log(`| ${name(s.model)} | ` + CHECKS.map((c) => `${s.byCheck[c].pass}/${s.byCheck[c].total}`).join(" | ") + " |");
}

console.log("\n| Model | Avg output tokens | Input read from cache | Cost per correct check |");
console.log("|---|---|---|---|");
for (const s of stats) {
  console.log(`| ${name(s.model)} | ${Math.round(s.avgOutputTokens)} | ${pct(s.cacheReadShare)} | ${usd(s.costPerCorrectCheck, 5)} |`);
}

console.log("\nMisses (ticket: runs missed of total, checks):");
for (const s of stats) {
  const m = Object.entries(s.misses).sort(([a], [b]) => a.localeCompare(b));
  console.log(`- ${name(s.model)}: ${m.length ? m.map(([id, x]) => `${id} ${x.runs}/${s.runs} (${x.checks.join(", ")})`).join("; ") : "none"}`);
}
