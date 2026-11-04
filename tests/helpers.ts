/**
 * Test helpers. Nothing here calls the real Anthropic API: tests use a fake client
 * that records each request and returns a canned, schema-valid response.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { Ticket, Triage } from "../shared/schema.ts";

export const TICKETS: Ticket[] = [
  {
    id: "T-1",
    title: "New SMS vendor TextFlare for appointment reminders",
    requester: "kevin (Patient Engagement)",
    submitted: "2026-11-03T12:30:00Z",
    body: "Switching reminders to TextFlare. Template includes appointment type. No BAA yet.",
  },
  {
    id: "T-2",
    title: "Container base image upgrade",
    requester: "nina (Platform)",
    submitted: "2026-11-03T09:00:00Z",
    body: "Moving services to node:22-bookworm-slim through the standard CI pipeline.",
  },
  {
    id: "T-3",
    title: "Admin access to prod Postgres",
    requester: "dev (Platform)",
    submitted: "2026-11-02T10:02:00Z",
    body: "Requesting permanent superuser on prod-main-db to debug deadlocks.",
  },
];

export function sampleTriage(overrides: Partial<Triage> = {}): Triage {
  return {
    request_type: "design_review",
    risk_level: "medium",
    risk_reason: "Test reason.",
    threat_categories: ["Information Disclosure"],
    data_sensitivity: "internal",
    hipaa: { applies: false, concerns: [] },
    multi_tenancy: { cross_tenant_risk: false, concerns: [] },
    missing_info: [],
    recommended_owner: "AppSec",
    suggested_next_step: "Review it.",
    injection_suspected: false,
    draft_response: "Thanks, we'll take a look.",
    policy_refs: [],
    ...overrides,
  };
}

export type ParseParams = {
  model: string;
  system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  messages: Array<{ role: string; content: string }>;
  output_config: { effort: string; format: unknown };
  fallbacks?: unknown;
  betas?: string[];
};

export interface FakeReply {
  stop_reason?: string;
  /** The triage to reply with; null means an empty reply. Defaults to a valid triage. */
  parsed_output?: Triage | null;
  /** Reply with this exact text instead, e.g. JSON that breaks the schema. */
  rawText?: string;
  throws?: Error;
}

/**
 * A stand-in for the Anthropic client. `reply` decides the response per request;
 * by default it returns a valid triage that cites the first retrieved <doc>, if any.
 */
export function fakeClient(reply: (params: ParseParams) => FakeReply = () => ({})) {
  const calls: ParseParams[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: ParseParams) => {
          calls.push(params);
          const r = reply(params);
          if (r.throws) throw r.throws;
          const firstDoc = params.messages[0].content.match(/<doc id="([^"]+)"/)?.[1];
          const parsed =
            r.parsed_output === undefined
              ? sampleTriage({
                  risk_level: params.messages[0].content.includes("superuser") ? "high" : "low",
                  policy_refs: firstDoc ? [{ doc_id: firstDoc, how_used: "Applied the policy." }] : [],
                })
              : r.parsed_output;
          const text = r.rawText ?? (parsed ? JSON.stringify(parsed) : "");
          return {
            model: params.model,
            stop_reason: r.stop_reason ?? "end_turn",
            content: text ? [{ type: "text", text }] : [],
            usage: { input_tokens: 200, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

/** Start an Express app on a free port. Call close() when done. */
export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A promise you can resolve from outside, for holding a request open in a test. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
