// @vitest-environment jsdom
/**
 * Functional: the real React app, driven like a user would, talking over HTTP to the
 * real Express app and triage pipeline. Only the Anthropic client is faked.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.tsx";
import { createApp } from "../../server/app.ts";
import { triageTicket } from "../../server/triage.ts";
import { fakeClient, listen, sampleTriage, TICKETS, type FakeReply, type ParseParams } from "../helpers.ts";

let server: Awaited<ReturnType<typeof listen>>;
let reply: (p: ParseParams) => FakeReply = () => ({});
let calls: ParseParams[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const app = createApp({
    allowedOrigins: new Set(),
    loadTickets: () => TICKETS,
    triageTicket: (ticket, model, options) => {
      const fake = fakeClient((p) => reply(p));
      const client = {
        beta: {
          messages: {
            create: async (p: ParseParams) => {
              calls.push(p);
              return (fake.client.beta.messages.create as unknown as (x: ParseParams) => Promise<unknown>)(p);
            },
          },
        },
      } as unknown as NonNullable<Parameters<typeof triageTicket>[2]>["client"];
      return triageTicket(ticket, model, { ...options, client });
    },
  });
  server = await listen(app);
  // The UI calls relative URLs like /api/tickets; send them to the test server.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${server.url}${input}` : input, init),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  reply = () => ({});
});
afterEach(cleanup);

const row = (title: string) => screen.getByRole("button", { name: new RegExp(title) });

describe("security review queue UI", () => {
  it("loads the queue with every ticket untriaged", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "Triage all 3" })).toBeEnabled();
    expect(screen.getAllByText("untriaged")).toHaveLength(3);
  });

  it("shows retrieved knowledge base excerpts before anything is triaged", async () => {
    render(<App />);
    expect(await screen.findByText(/Retrieved from knowledge base: \d excerpts?/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("triages the whole queue, sorts by risk and totals the cost", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Triage all 3" }));

    await waitFor(() => expect(screen.queryAllByText("untriaged")).toHaveLength(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "Triage all 3" })).toBeEnabled());
    // The fake rates the superuser request high and the others low, so it sorts first.
    const rows = within(document.querySelector<HTMLElement>("ul.queue")!).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Admin access to prod Postgres");
    expect(rows[0]).toHaveTextContent("Opus 5.5 · RAG");
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText(/^\$0\.\d{3}$/)).toBeInTheDocument();
  });

  it("triages one ticket and shows the analysis with valid policy references", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Triage" }));
    expect(await screen.findByText("Policy references")).toBeInTheDocument();
    expect(screen.queryByText(/not in retrieved context/)).not.toBeInTheDocument();
    expect(screen.getByText("Thanks, we'll take a look.")).toBeInTheDocument();
  });

  it("flags a cited excerpt that wasn't retrieved", async () => {
    reply = () => ({ parsed_output: sampleTriage({ policy_refs: [{ doc_id: "made-up#doc", how_used: "x" }] }) });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Triage" }));
    expect(await screen.findByText("made-up#doc (not in retrieved context)")).toBeInTheDocument();
  });

  it("sends the chosen model and RAG setting, and labels the result with them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(await screen.findByRole("combobox"), "claude-haiku-5-5");
    await user.click(screen.getByRole("checkbox", { name: "Use knowledge base (RAG)" }));
    expect(screen.getByText("Knowledge base off: the model sees only the ticket.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Triage" }));
    await waitFor(() => expect(row("New SMS vendor")).toHaveTextContent("Haiku 5.5 · no RAG"));
    expect(calls[0].model).toBe("claude-haiku-5-5");
    expect(calls[0].messages[0].content).not.toContain("<context>");
  });

  it("shows an error, with the billed cost, instead of getting stuck", async () => {
    reply = () => ({ stop_reason: "refusal", parsed_output: null });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Triage" }));
    expect(await screen.findByText(/The model declined to triage this ticket/)).toHaveTextContent(/still billed/);
    expect(row("New SMS vendor")).toHaveTextContent("error");
    // The button is usable again for a retry.
    expect(screen.getByRole("button", { name: "Triage" })).toBeEnabled();
  });

  it("recovers when the API is unreachable", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/triage") ? Promise.reject(new TypeError("Failed to fetch")) : realFetch(`${server.url}${input}`, init),
    );
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "Triage" }));
      expect(await screen.findByText(/Could not reach the API: Failed to fetch/)).toBeInTheDocument();
      expect(screen.queryByText("running")).not.toBeInTheDocument();
    } finally {
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        realFetch(typeof input === "string" && input.startsWith("/") ? `${server.url}${input}` : input, init),
      );
    }
  });
});
