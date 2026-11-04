# Security Review Queue: an LLM triage demo

A TypeScript + React app that sends a queue of 20 security review tickets to Claude and gets each one back as schema-validated JSON: risk level, STRIDE categories, HIPAA and multi-tenant concerns, owner, missing info, policy citations and a draft reply. A knowledge base of internal policies is retrieved with BM25 (RAG), and an eval scores the output against expected labels.

This README is for reviewers. It covers where to start reading, how to check the code without spending money, the design decisions behind it, and the known gaps.

## Review in 10 minutes

Read these in order:

| # | File | What to look for |
|---|---|---|
| 1 | [`server/triage.ts`](server/triage.ts) | The whole LLM integration: `SYSTEM_PROMPT`, `buildUserPrompt()` (escaping), `triageTicket()` (the API call, error paths, metrics) |
| 2 | [`shared/schema.ts`](shared/schema.ts) | The Zod output schema. Its `.describe()` text goes to the model too, so it's part of the prompt |
| 3 | [`server/app.ts`](server/app.ts) | The Express API and the guards on paid routes |
| 4 | [`server/retrieval.ts`](server/retrieval.ts) | BM25 over `kb/`, top 4 chunks, 40% relative-score cutoff |
| 5 | [`eval/score.ts`](eval/score.ts), [`eval/expected.json`](eval/expected.json) | How accuracy is defined |
| 6 | [`MODEL-COMPARISON.md`](MODEL-COMPARISON.md) | Measured accuracy, cost and latency per model |

`src/` (the React UI) and `tests/` are worth a skim, but the decisions that matter are in the files above.

## Verify it for free

None of these call the Anthropic API, and no key is needed. Every test uses the fake client in [`tests/helpers.ts`](tests/helpers.ts), which records each request and returns a canned, schema-valid reply.

```bash
npm ci
npm run typecheck          # app, server and test tsconfigs
npm test                   # 79 tests across unit, integration and functional
npm run build              # production UI bundle
```

| Layer | Covers |
|---|---|
| `tests/unit` | Escaping, prompt building, BM25, cost math, scoring, SSE parsing, eval aggregation |
| `tests/integration` | The triage pipeline against the real `kb/`, and the Express API over HTTP |
| `tests/functional` | The React UI driven like a user (Testing Library + jsdom) against the real API in-process |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same four steps on every push and PR, with no API key.

To check what the model would receive without paying for a call, start the app (below) and use **Show the prompt sent to the model**, or `GET /api/tickets/:id/prompt`.

## Paid vs. free

Every API call costs the owner money. Review with the free checks above. Only these are paid:

- `npm run eval`, `POST /api/tickets/:id/triage`, `POST /api/triage-all`, and the **Triage** buttons in the UI.
- A full 20-ticket run costs about **$0.30 on Opus 5.5** and **$0.01 on Haiku 5.5**. `npm run eval` shows the estimate and asks before it runs.
- For a targeted check: `npm run eval -- --only SEC-107,SEC-118 --yes`.

## Design decisions

**Prompt structure.** The system prompt (rubric, owners, HIPAA and multi-tenant rules, output limits) is identical for every ticket and marked with `cache_control`. Per-ticket content, meaning the retrieved excerpts and the ticket itself, goes in the user message after the cache marker. In the eval runs, 87% of input tokens were read from the cache. During "Triage all", the first ticket runs alone so it writes the cache before the other requests start in parallel.

**Structured output, validated by us.** `triageTicket` calls `messages.create` with `output_config.format` set to the JSON schema, then validates the reply itself with `parseTriage`. It does not use the SDK's `messages.parse`. That way a reply that breaks the schema still returns its billed token counts, and the error names the field and the bad value.

**Every failure carries its cost.** Refusals, `max_tokens` cut-offs and schema failures return an error result that includes metrics, so the on-screen cost total reflects what was actually billed.

**Refusal fallback.** Security tickets can trigger safety classifiers (exploit details, for example). On models that support it (`supportsFallback` in [`shared/models.ts`](shared/models.ts), currently Opus only), the request sends `fallbacks: "default"` so the API re-runs a declined request on a fallback model. Haiku rejects the parameter, so it isn't sent there. `metrics.fallbackUsed` records when a fallback served the request.

**Effort `low`.** For a short classification task, `low` effort kept accuracy at 100% on Opus across three runs while keeping output tokens down. See [`MODEL-COMPARISON.md`](MODEL-COMPARISON.md).

**RAG is local BM25.** No embeddings service or second key. Each `## ` section in `kb/` is one chunk. Up to 4 chunks are kept, and only those scoring at least 40% of the best match (`MIN_RELATIVE_SCORE`). The model cites what it relied on in `policy_refs`, and both the UI and the eval flag any cited id that wasn't actually retrieved. An honest caveat: a knowledge base this small would be cheaper to put whole in the cached system prompt. RAG is here to demonstrate the pattern, which pays off on corpora too big or too volatile to send every time.

**Prompt versioning.** `PROMPT_VERSION` is a hash of `SYSTEM_PROMPT` plus the output schema. Eval results are tagged with it, and `npm run eval:report` only compares runs made with the same prompt.

**Model choice.** The UI offers Opus 5.5 and Haiku 5.5. Sonnet 5.5 was evaluated and removed: with this prompt, which was tuned on the other two models, it scored below Haiku at 18× the cost.

## Trust boundaries and safety rails

The threats here are a hostile ticket and someone else spending the owner's API budget.

| Concern | Control | Where |
|---|---|---|
| Ticket text is untrusted | Every ticket field is XML-escaped in `buildUserPrompt`, so a ticket can't close its own tags or forge a `<doc>` excerpt. The prompt tells the model to treat ticket text as data and to set `injection_suspected` when a ticket tries to give instructions | `server/triage.ts` |
| Injection in practice | SEC-107 contains "Ignore all previous instructions…". It is flagged, not obeyed, in every eval run on every model | `server/tickets.json` |
| Network exposure | The API binds to `127.0.0.1` by default. `HOST=0.0.0.0` has to be set explicitly | `server/index.ts` |
| Cross-site requests | Browser requests with an `Origin` outside `ALLOWED_ORIGINS` get 403 | `server/app.ts` |
| Accidental spend | Paid routes are POST-only, so a link or prefetch can't start one. One batch at a time (409), at most 4 single-ticket calls in flight (429) | `server/app.ts` |
| Key exposure | The key stays on the server. Vite proxies `/api`, so the browser never sees it | `vite.config.ts` |
| Model input | The model id must be one of the ids in `shared/models.ts` (400 otherwise) | `server/app.ts` |

**Data handling.** Ticket text and retrieved excerpts are sent to the Anthropic API. No request parameter controls retention or privacy. That depends on the account's commercial terms and retention settings, including Zero Data Retention if the organization has it. For real tickets, check those settings, and consider redacting secrets before `buildUserPrompt`.

## Results so far

From [`MODEL-COMPARISON.md`](MODEL-COMPARISON.md): 3 runs per model, 20 tickets, 105 scored checks per run.

| | Opus 5.5 | Haiku 5.5 |
|---|---|---|
| Accuracy (mean of 3) | 100.0% | 99.0% |
| Cost per 20 tickets | $0.300 | $0.009 |
| Avg latency per call | 6.9s | 3.9s |

Both models were perfect on cross-tenant risk, injection detection and citation validity. Haiku's misses were one-offs, never the same ticket twice.

## Known limitations and open questions

- **The labels are Claude-written.** `eval/expected.json` hasn't been reviewed by a security team, so 100% means agreement with those labels, not proof of correctness. Reviewing the labels is the most useful thing a domain reviewer can do.
- **Small sample.** 20 tickets × 3 runs. One miss moves a run by about 1 point.
- **The prompt is tuned for Opus 5.5 and Haiku 5.5 only.** Other models would need their own tuning and eval runs.
- **"May contain PHI" reasoning.** The smaller models sometimes flag HIPAA on a possibility, where the prompt says "would". SEC-110's label is debatable too.
- **Retrieval gaps.** Keyword search can miss a relevant section (the Datadog BAA entry isn't retrieved for SEC-110). Raising the 40% cutoff cuts noise but has dropped useful excerpts before.
- **Cost figures are estimates** from token counts at list prices, and are priced at the requested model even when a fallback served the request.
- **Single-user design.** The in-flight limits live in process memory. There's no auth, because the server is meant to run on localhost only.

## Run it

Requires Node 22.9 or later.

```bash
npm install
cp .env.example .env    # then set ANTHROPIC_API_KEY
npm run dev             # UI on http://localhost:5180, API on 127.0.0.1:3001
```

To serve the built UI from the API server instead: `npm run build`, then `npm start`, and open http://127.0.0.1:3001.

| Setting | Default | Notes |
|---|---|---|
| `API_PORT` | 3001 | Read by both the server and the Vite proxy (not `PORT`, which preview tooling sets for Vite) |
| `WEB_PORT` | 5180 | Vite dev server |
| `HOST` | 127.0.0.1 | `0.0.0.0` lets other devices on the network spend your API budget |
| `ALLOWED_ORIGINS` | localhost and 127.0.0.1 on both ports | Comma-separated |

### Things to try (paid)

1. **Show the prompt** on any ticket (free), then **Triage** it and open **Raw JSON**.
2. **SEC-107:** the prompt-injection ticket is flagged in `risk_reason` and `injection_suspected`.
3. **SEC-118, RAG off vs. on:** with RAG off, Claude says to get a BAA signed. With RAG on, it cites the vendor register (TextFlare refuses BAAs) and points to Twilio as the approved alternative.
4. **SEC-116 to SEC-120:** HIPAA and multi-tenant cases (a cache key leaking PHI across tenants, support impersonation, training on clinical notes, customer-managed keys).
5. **Model picker:** run the same ticket on Opus and Haiku and compare. The stat bar shows tokens, cached tokens, estimated cost and latency.

### Eval

```bash
npm run eval -- --model claude-haiku-5-5        # about 1¢
npm run eval -- --effort medium --rag off       # Opus by default
npm run eval -- --only SEC-102,SEC-118 --yes    # subset, no confirmation
npm run eval:report                             # free: tables from saved runs for the current prompt
```

Results are saved to `eval/results/`, which is not committed. A single run is noisy: a miss that repeats across runs points to a prompt or label issue, and a one-off is usually variance.

## Layout

```
server/index.ts      Starts the server (host, port, allowed origins)
server/app.ts        Express API: list tickets, preview a prompt, triage one, triage all (SSE)
server/triage.ts     The Claude call, prompt, escaping, metrics
server/retrieval.ts  BM25 search over kb/
server/paths.ts      File paths that work under Node and jsdom
server/tickets.json  Sample queue (20 tickets)
kb/                  Knowledge base (Markdown, one chunk per ## section)
shared/schema.ts     Zod output schema and shared types
shared/models.ts     Selectable models, prices, fallback support
src/App.tsx          React UI
src/api.ts           API calls, SSE parsing, error normalization
eval/                Expected labels, scoring, paid eval runner, report
tests/               unit/, integration/, functional/, and the fake client in helpers.ts
MODEL-COMPARISON.md  Latest cost vs. accuracy write-up
CLAUDE.md            Working rules for AI agents editing this repo
```
