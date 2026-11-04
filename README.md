# Security Review Queue: an LLM triage demo

A small TypeScript + React app that sends a queue of security review tickets to Claude through code. Each ticket comes back as typed JSON: risk level, STRIDE categories, HIPAA and multi-tenant concerns, owner, missing info and a draft reply.

## Run it

```bash
npm install
cp .env.example .env    # then put your key in ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:5180. The API server runs on 127.0.0.1:3001, and Vite proxies `/api` to it, so the key never reaches the browser. Requires Node 22.9 or later.

To serve the built UI from the API server instead: `npm run build`, then `npm start` and open http://127.0.0.1:3001.

| Setting | Default | |
|---|---|---|
| `API_PORT` | 3001 | Read by both the server and the Vite proxy |
| `WEB_PORT` | 5180 | Vite dev server |
| `HOST` | 127.0.0.1 | Only set `0.0.0.0` if you want other devices to be able to spend your API budget |
| `ALLOWED_ORIGINS` | localhost and 127.0.0.1 on both ports | Comma-separated; browser requests from any other origin get 403 |

## Safety rails

- The API only listens on this machine and rejects browser requests from other sites.
- Paid actions are POST only. One batch can run at a time (409 otherwise), and at most 4 single-ticket calls can be in flight (429 otherwise).
- Ticket text is XML-escaped before it goes in the prompt, so a ticket can't close its own tags or forge a knowledge base excerpt.
- Failed calls that were still billed (refusals, cut-off output) count toward the cost total.

## What to show in a demo

1. **Show the prompt sent to the model** on any ticket. It shows the fixed system prompt (rubric and rules) and the templated user message that wraps the ticket in `<ticket>` tags.
2. **Triage** one ticket, then open **Raw JSON**. It's guaranteed to match the Zod schema in `shared/schema.ts`.
3. **Triage all 20.** Requests run 4 at a time, and results stream back over Server-Sent Events. Watch the queue re-sort by risk.
4. **SEC-107** contains a prompt-injection attempt ("Ignore all previous instructions…"). It gets flagged rather than obeyed.
5. **SEC-116 to SEC-120** cover HIPAA and multi-tenancy: a cache key that can leak PHI across tenants, support impersonation of any tenant, an SMS vendor with no BAA, training on clinical notes, and customer-managed keys. Watch the PHI and tenant flags.
6. **RAG on vs. off.** Untick "Use knowledge base (RAG)" and triage SEC-118: Claude says to get a BAA signed. Tick it and re-run: it cites the vendor register (TextFlare refuses BAAs and keeps messages for 2 years) and points to Twilio as the approved alternative. Open "Retrieved from knowledge base" to see which sections were pulled and which words matched.
7. **Model picker.** Run the same ticket on Opus and Haiku and compare quality, speed and cost.
8. The stat bar shows tokens, cached tokens, estimated cost and average latency, which covers the real-world tradeoffs. Each row is labeled with the model and RAG setting that produced it.

## Where the LLM call lives

All of it is in [`server/triage.ts`](server/triage.ts):

- `SYSTEM_PROMPT`: the instructions, the same for every ticket
- `buildUserPrompt()`: puts the retrieved knowledge base excerpts and the ticket into a template
- `triageTicket()`: one `client.beta.messages.parse()` call with
  - the model chosen in the UI (list in `shared/models.ts`)
  - the system prompt marked with `cache_control`, so it's cached after the first ticket
  - `output_config.format: betaZodOutputFormat(TriageSchema)` for structured output
  - `output_config.effort: "low"`
  - `fallbacks: "default"` (Opus and Sonnet): if a safety classifier declines a ticket (possible with exploit details), the API retries it on a recommended fallback model

## RAG

`kb/` holds the security team's knowledge base: vendor register, access policy, multi-tenant standard, HIPAA policy, data classification, runbooks, AppSec standards, GRC policies and past decisions. Each `## ` section is one chunk.

[`server/retrieval.ts`](server/retrieval.ts) scores every chunk against the ticket with BM25 keyword search and returns up to 4. That runs locally, with no extra service or API key. In production you'd usually swap `search()` for vector search over embeddings; the rest of the pipeline stays the same.

The excerpts go in the user message, after the cache marker, because they change for each ticket. Claude lists what it relied on in `policy_refs`, and the UI flags any cited id that wasn't in the retrieved context.

Honest caveat for a demo: a knowledge base this small would be cheaper to put entirely in the cached system prompt. RAG pays off when the corpus is too big, or changes too often, to send every time.

To try a change live: edit `SYSTEM_PROMPT` and `tsx watch` restarts the server; edit a file in `kb/` or `server/tickets.json` and it's re-read on the next request.

## Tests

None of the tests call the Anthropic API. They use a fake client that records each request and returns a canned, schema-valid answer.

```bash
npm test                  # everything
npm run test:unit         # pure functions: escaping, prompt building, BM25, cost math, scoring, SSE parsing
npm run test:integration  # triage pipeline + real kb/ retrieval, and the Express API over HTTP
npm run test:functional   # the React UI driven like a user, against the real API in-process
```

## Eval (paid)

`eval/expected.json` holds expected labels for all 20 tickets: risk level, the HIPAA and cross-tenant flags, owner and injection. It's a starting point: review the labels with your security team. `npm run eval` triages every ticket and scores the results, including whether every citation was in the retrieved context. It shows an estimated cost and asks before running.

```bash
npm run eval -- --model claude-haiku-5-5        # about 1¢
npm run eval -- --effort medium --rag off       # Opus by default
npm run eval -- --only SEC-102,SEC-118 --yes    # subset, no prompt
```

Results are saved to `eval/results/`. Use it to check a prompt change, or whether `low` effort costs accuracy, before trusting a spot check.

## Layout

```
server/index.ts     Starts the server (host, port, allowed origins)
server/app.ts       Express API: list tickets, preview a prompt, triage one, triage all (SSE)
server/triage.ts    The Claude call
server/retrieval.ts BM25 search over kb/
kb/                 Knowledge base (Markdown)
server/tickets.json Sample queue (20 tickets)
shared/schema.ts    Zod schema and shared types
shared/models.ts    Models the UI can pick, with prices
src/App.tsx         React UI
src/api.ts          API calls, SSE parsing, error normalization
eval/               Expected labels, scoring, paid eval runner
tests/              unit/, integration/, functional/
```
