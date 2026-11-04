# Model comparison: cost vs accuracy

Three runs per model of the 20-ticket eval, all with the same prompt (version `5cf72779`), on 2026-11-04. Total spend: **$1.42**.

## Summary

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Accuracy (mean of 3 runs) | **100.0%** | 97.8% | 99.0% |
| Perfect runs | **3 / 3** | 0 / 3 | 1 / 3 |
| Cost per run (20 tickets) | $0.300 | $0.165 | **$0.009** |
| Cost per 1,000 tickets | $15.00 | $8.20 | **$0.40** |
| Avg time per call | 6.9s | 4.8s | **3.9s** |

- **Opus** was the only model with no misses in any run. It costs about 33× as much as Haiku.
- **Haiku** came within 1 point of Opus at about 3% of the cost, and it was the fastest. Its misses were one-offs, never the same ticket twice.
- **Sonnet** cost 18× as much as Haiku and scored lower. It also had the most serious miss of the three (see SEC-108 below). On this task and this prompt, it's the weakest choice.

**Recommendation for this workload:** run **Haiku** as the first-pass triager, and send anything it rates high or critical, or flags for PHI, to **Opus** for confirmation. A human makes the final call either way. In these runs Haiku sent 14 of 20 tickets down that path (high, critical or PHI), so the blended cost would be roughly $0.009 + 14 × $0.015 ≈ **$0.22 per 20 tickets**, about 27% less than all-Opus. The saving is modest because most of this queue is serious by design; a real queue with more routine tickets would save more. The estimate hasn't been measured as a pipeline.

## Setup

- 20 tickets (`server/tickets.json`), scored against `eval/expected.json` on six checks per ticket: risk level, HIPAA flag, cross-tenant flag, owner, injection flag and citation validity. Checks with an expected value of "either" are skipped, so each run has 105 scored checks.
- Same settings for every model: effort `low`, RAG on, prompt caching on, 4 concurrent calls after one cache-warming call.
- Costs are estimates from token counts and list prices in `shared/models.ts`.

## Results

### Accuracy and cost

| Model | Runs | Accuracy (mean) | Range | Perfect runs | Cost / run | Cost / ticket | Avg call latency | Avg run time | Errors |
|---|---|---|---|---|---|---|---|---|---|
| Claude Opus 5.5 | 3 | 100.0% | 100.0%–100.0% | 3/3 | $0.300 | $0.0150 | 6.9s | 44s | 0 |
| Claude Sonnet 5.5 | 3 | 97.8% | 97.1%–99.0% | 0/3 | $0.165 | $0.0082 | 4.8s | 31s | 0 |
| Claude Haiku 5.5 | 3 | 99.0% | 98.1%–100.0% | 1/3 | $0.009 | $0.0004 | 3.9s | 26s | 0 |

Individual runs: Opus $0.308, $0.300, $0.291 (100% each). Sonnet $0.171, $0.163, $0.161 (97%, 99%, 97%). Haiku $0.009, $0.008, $0.009 (98%, 100%, 99%).

### Passes per check (across all 3 runs)

| Model | Risk level | HIPAA | Cross-tenant | Owner | Injection | Citations |
|---|---|---|---|---|---|---|
| Claude Opus 5.5 | 60/60 | 45/45 | 30/30 | 60/60 | 60/60 | 60/60 |
| Claude Sonnet 5.5 | 60/60 | 40/45 | 30/30 | 58/60 | 60/60 | 60/60 |
| Claude Haiku 5.5 | 59/60 | 43/45 | 30/30 | 60/60 | 60/60 | 60/60 |

All three models were perfect on cross-tenant risk, prompt injection (SEC-107) and citations: no model cited an excerpt it wasn't given.

### Tokens and caching

| Model | Avg output tokens | Input read from cache | Cost per correct check |
|---|---|---|---|
| Claude Opus 5.5 | 585 | 87.2% | $0.00285 |
| Claude Sonnet 5.5 | 620 | 87.2% | $0.00161 |
| Claude Haiku 5.5 | 675 | 87.2% | $0.00008 |

Caching works the same on every model: 87% of input tokens are read from the cache. Output dominates the bill, and the smaller models write slightly more of it.

## What each model got wrong

Not all misses are equal. A missed PHI flag on a possible breach matters far more than a debatable owner.

| Ticket | Model | Runs missed | What happened | Severity |
|---|---|---|---|---|
| SEC-108 (leaked AWS key, data lake) | Sonnet | 2 / 3 | Rated critical and routed correctly, but said HIPAA doesn't apply, though the key reaches a data lake holding tenant PHI. That skips the breach-assessment and tenant-notification path. | **High** |
| SEC-110 (checkout body logging) | Sonnet, Haiku | 3 / 3, 1 / 3 | Flagged PHI because request bodies "may contain PHI". Sonnet also said Datadog's BAA status was "unconfirmed"; the knowledge base says it's signed, but that section wasn't retrieved for this ticket. | Low: the label is debatable, and there's a retrieval gap |
| SEC-111 (base image upgrade) | Sonnet | 2 / 3 | Owner AppSec instead of CloudSec. Risk (low) and decision (pre-approved) were right. | Low |
| SEC-101 (ID document bucket) | Haiku | 1 / 3 | Rated medium instead of high, reasoning that the request matches the approved SEC-042 pattern. | Medium |
| SEC-105 (partner API) | Haiku | 1 / 3 | Flagged PHI because partner orders "may contain PHI". | Low |

**A pattern across models:** most HIPAA misses come from "may contain PHI" reasoning, while the prompt asks for "would". The smaller models stretch the rule; Opus applies it literally.

## Caveats

- **The labels are Claude-written.** A perfect score means agreement with those labels, which isn't proof of correctness. A security team should review `eval/expected.json`.
- **Small sample:** 20 tickets × 3 runs. One miss moves a run by about 1 point, so the Haiku–Sonnet gap (1.2 points) is suggestive, not conclusive.
- **One effort setting.** Every model ran at `low`. Sonnet's default is `high` and Haiku's is `medium`; at those levels Sonnet and Haiku might close the gap, at higher cost. That's untested.
- **Prompt tuned on Opus and Haiku.** The prompt was iterated against those two models, never Sonnet, which may partly explain Sonnet's lower score.
- **Estimated costs** come from token counts at list prices, not an invoice.

## Next experiments

1. **Sonnet at `medium` and `high` effort**, to see whether its misses are an effort issue (about $0.20–0.40 per run).
2. **A measured Haiku → Opus pipeline**, to confirm the blended cost and that Opus overturns Haiku's misses.
3. **SEC-110:** decide whether the HIPAA label should be "either", and lower the retrieval threshold so the Datadog BAA entry is retrieved.
4. **Tighten the HIPAA wording** ("only if the request itself would…, not may") and re-run Sonnet and Haiku.

## Reproduce

```bash
npm run eval -- --model claude-opus-5-5 --yes     # repeat per model and run
npm run eval:report                               # free: tables for the current prompt version
```
