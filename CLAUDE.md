# CLAUDE.md

Demo app: Claude triages security review tickets into typed JSON. See README.md for features and commands.

## Paid vs free

Every Anthropic API call costs the owner money. Sort every action into one of two kinds before running it:

- **Free:** `npm run typecheck`, `npm test` (all three layers use the fake client in `tests/helpers.ts`), `npm run build`, the `/api/tickets/:id/prompt` preview, and retrieval.
- **Paid:** `npm run eval`, `POST /api/tickets/:id/triage`, `POST /api/triage-all`, and "Triage" buttons in the UI.

Verify with free checks first. For a paid check, use `npm run eval -- --only <ids> --yes` on the 2–3 tickets the change affects, and state the cost. Ask the owner before any full-queue or repeated run. Rough cost per full 20-ticket run: Opus ~$0.30, Sonnet ~$0.15, Haiku ~$0.01.

## Changing the prompt

The model's instructions are `SYSTEM_PROMPT` in `server/triage.ts` **and** the `.describe()` text in `shared/schema.ts`; the API sends both. Keep them saying the same thing: a mismatch between them once caused drifting flags.

- Any edit changes `PROMPT_VERSION`, invalidates the prompt cache (the next call pays ~1¢ to re-cache), and makes earlier eval results incomparable.
- Put an exception next to the rule it modifies. Haiku ignored "unshipped designs are high, not critical" while it sat in the multi-tenant section, and followed it once it moved into the risk rubric.
- `eval/expected.json` holds Claude-written labels. Change a label only to match a rule the owner decided, and say so.
- A single eval run is noisy. A miss that repeats across runs is a prompt or label issue; a one-off is variance.
- The prompt is tuned for Opus 5.5 and Haiku 5.5, and not for Sonnet 5.5. When reporting Sonnet results, say so.

## Invariants

- Ticket text is untrusted. It goes through `escapeXml` in `buildUserPrompt`, so a ticket can't close its tags or forge a `<doc>` excerpt. Keep every ticket field escaped.
- The API binds to `127.0.0.1`, rejects foreign `Origin` headers, keeps paid routes POST-only, and allows one batch at a time. These guard the owner's API budget.
- `triageTicket` calls `messages.create` and validates with `parseTriage` itself (not the SDK's `messages.parse`), so a reply that breaks the schema still returns its billed token counts and names the bad value.
- `fallbacks` is sent only for models with `supportsFallback` in `shared/models.ts`; Haiku rejects it.

## Gotchas

- The API port is `API_PORT`, not `PORT`: the preview tooling sets `PORT` for Vite and the two collided.
- The Vite proxy targets `127.0.0.1`, not `localhost`: on Windows `localhost` can resolve to IPv6 `::1`, where the API isn't listening.
- Server modules resolve file paths with `fromModule` (`server/paths.ts`), because under jsdom (functional tests) `import.meta.url` is an `http:` URL.
- `kb/*.md` and `server/tickets.json` are re-read when they change; a `SYSTEM_PROMPT` edit needs the `tsx watch` restart.
- Retrieval keeps chunks scoring at least 40% of the best match (`MIN_RELATIVE_SCORE`). Raising it cuts noise but can drop useful excerpts: Haiku once claimed Datadog had no BAA after the Datadog entry stopped being retrieved.
