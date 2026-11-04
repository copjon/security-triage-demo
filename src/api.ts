import type { PromptPreview, Ticket, TriageResult } from "../shared/schema";

/**
 * Turn any API response into a TriageResult. Error bodies, HTML error pages from a
 * proxy and network failures all become a status "error" result instead of
 * crashing the UI or leaving a row stuck on "running".
 */
export function normalizeResult(ticketId: string, body: unknown, httpStatus?: number): TriageResult {
  if (body && typeof body === "object" && "status" in body) {
    const b = body as Partial<TriageResult> & { error?: unknown };
    if (b.status === "ok" && "triage" in b && b.triage) return b as TriageResult;
    if (b.status === "error") {
      return { ...(b as TriageResult), ticketId, status: "error", error: String(b.error ?? "Unknown error") };
    }
  }
  const message =
    body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "Unexpected response";
  return { ticketId, status: "error", error: httpStatus ? `HTTP ${httpStatus}: ${message}` : message };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `The server returned a non-JSON response (HTTP ${res.status}).` };
  }
}

export async function fetchTickets(): Promise<Ticket[]> {
  const res = await fetch("/api/tickets");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return (await res.json()) as Ticket[];
}

export async function fetchPreview(ticketId: string, query: string): Promise<PromptPreview> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/prompt?${query}`);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return (await res.json()) as PromptPreview;
}

export async function triageOneRequest(ticketId: string, query: string): Promise<TriageResult> {
  try {
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/triage?${query}`, { method: "POST" });
    return normalizeResult(ticketId, await readJson(res), res.ok ? undefined : res.status);
  } catch (err) {
    return { ticketId, status: "error", error: `Could not reach the API: ${(err as Error).message}` };
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse Server-Sent Events from a text buffer. Returns the complete events and the
 * leftover text (a partial event still waiting for more data).
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/**
 * Start a batch run and call onEvent for each streamed event. Uses fetch + POST
 * (EventSource can only send GET). Resolves when the stream ends; throws with the
 * server's message if the batch couldn't start (e.g. one is already running).
 */
export async function streamBatch(query: string, onEvent: (e: SseEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/triage-all?${query}`, { method: "POST", signal });
  if (!res.ok || !res.body) {
    const body = (await readJson(res)) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    events.forEach(onEvent);
  }
}
