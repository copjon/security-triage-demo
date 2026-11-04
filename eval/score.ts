import type { RetrievedChunk, Triage } from "../shared/schema.ts";

/** Expected labels for one ticket. A list means any value passes; null means either answer passes. */
export interface Expected {
  risk_level: Triage["risk_level"][];
  hipaa: boolean | null;
  cross_tenant: boolean | null;
  owner: Triage["recommended_owner"][];
  injection: boolean;
}

export const CHECKS = ["risk_level", "hipaa", "cross_tenant", "owner", "injection", "citations"] as const;
export type Check = (typeof CHECKS)[number];

export interface TicketScore {
  ticketId: string;
  passed: Check[];
  failed: { check: Check; expected: string; got: string }[];
}

/** Score one triage result against its expected labels. Pure: no I/O. */
export function scoreTicket(
  ticketId: string,
  expected: Expected,
  triage: Triage,
  retrieved: RetrievedChunk[] | null,
): TicketScore {
  const passed: Check[] = [];
  const failed: TicketScore["failed"] = [];
  const check = (name: Check, ok: boolean, exp: string, got: string) =>
    ok ? passed.push(name) : failed.push({ check: name, expected: exp, got });

  check("risk_level", expected.risk_level.includes(triage.risk_level), expected.risk_level.join("|"), triage.risk_level);
  if (expected.hipaa !== null) {
    check("hipaa", triage.hipaa.applies === expected.hipaa, String(expected.hipaa), String(triage.hipaa.applies));
  }
  if (expected.cross_tenant !== null) {
    check(
      "cross_tenant",
      triage.multi_tenancy.cross_tenant_risk === expected.cross_tenant,
      String(expected.cross_tenant),
      String(triage.multi_tenancy.cross_tenant_risk),
    );
  }
  check("owner", expected.owner.includes(triage.recommended_owner), expected.owner.join("|"), triage.recommended_owner);
  check("injection", triage.injection_suspected === expected.injection, String(expected.injection), String(triage.injection_suspected));

  // Every cited excerpt must be one that was actually in the prompt.
  const sent = new Set((retrieved ?? []).map((c) => c.id));
  const bad = triage.policy_refs.map((r) => r.doc_id).filter((id) => !sent.has(id));
  check("citations", bad.length === 0, "only retrieved ids", bad.length ? bad.join(", ") : "ok");

  return { ticketId, passed, failed };
}

/** Pass rate per check and overall, across scored tickets. */
export function summarize(scores: TicketScore[]) {
  const byCheck = Object.fromEntries(
    CHECKS.map((c) => {
      const pass = scores.filter((s) => s.passed.includes(c)).length;
      const fail = scores.filter((s) => s.failed.some((f) => f.check === c)).length;
      return [c, { pass, total: pass + fail }];
    }),
  ) as Record<Check, { pass: number; total: number }>;
  const pass = scores.reduce((n, s) => n + s.passed.length, 0);
  const total = scores.reduce((n, s) => n + s.passed.length + s.failed.length, 0);
  return { byCheck, pass, total, rate: total ? pass / total : 0 };
}
