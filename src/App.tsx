import { useEffect, useMemo, useState } from "react";
import type { Ticket, TriageResult, PromptPreview, Triage, RetrievedChunk } from "../shared/schema";
import { MODELS, DEFAULT_MODEL, findModel } from "../shared/models";
import { fetchPreview, fetchTickets, streamBatch, triageOneRequest } from "./api";
import { configLabel } from "./format";

const MODEL_STORAGE_KEY = "triage-model";
const RAG_STORAGE_KEY = "triage-rag";
function loadSavedRag(): boolean {
  try {
    return localStorage.getItem(RAG_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}
function loadSavedModel(): string {
  try {
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved && findModel(saved)) return saved;
  } catch {}
  return DEFAULT_MODEL;
}

type RowState = { status: "idle" } | { status: "running" } | TriageResult;

const RISK_ORDER: Record<Triage["risk_level"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

const label = (s: string) => s.replace(/_/g, " ");

export default function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(loadSavedModel);

  function chooseModel(id: string) {
    setModel(id);
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch {}
  }
  const [useRag, setUseRag] = useState<boolean>(loadSavedRag);
  function chooseRag(on: boolean) {
    setUseRag(on);
    try {
      localStorage.setItem(RAG_STORAGE_KEY, on ? "1" : "0");
    } catch {}
  }
  const modelQuery = `model=${encodeURIComponent(model)}&rag=${useRag ? 1 : 0}`;

  useEffect(() => {
    fetchTickets()
      .then((data) => {
        setTickets(data);
        setSelectedId(data[0]?.id ?? null);
      })
      .catch(() => setLoadError("Could not reach the triage API. Is the server running? Try npm run dev."));
  }, []);

  const setRow = (id: string, state: RowState) => setRows((prev) => ({ ...prev, [id]: state }));

  async function triageOne(id: string) {
    setRow(id, { status: "running" });
    setRow(id, await triageOneRequest(id, modelQuery));
  }

  async function triageAll() {
    setBatchRunning(true);
    setBatchError(null);
    setRows({});
    try {
      await streamBatch(modelQuery, ({ event, data }) => {
        if (event === "started") setRow(JSON.parse(data).ticketId, { status: "running" });
        if (event === "result") {
          const result = JSON.parse(data) as TriageResult;
          setRow(result.ticketId, result);
        }
      });
    } catch (err) {
      setBatchError(`Batch failed: ${(err as Error).message}`);
    } finally {
      // If the stream ended early (server restart, network drop), don't leave rows spinning.
      setRows((prev) => {
        const next = { ...prev };
        for (const [id, r] of Object.entries(next)) {
          if (r.status === "running") next[id] = { ticketId: id, status: "error", error: "The batch stopped before this ticket finished." };
        }
        return next;
      });
      setBatchRunning(false);
    }
  }

  // Triaged tickets first, by risk; then everything else in queue order.
  const sorted = useMemo(() => {
    const rank = (t: Ticket) => {
      const r = rows[t.id];
      return r?.status === "ok" ? RISK_ORDER[r.triage.risk_level] : 9;
    };
    return [...tickets].sort((a, b) => rank(a) - rank(b));
  }, [tickets, rows]);

  const totals = useMemo(() => {
    const all = Object.values(rows);
    const ok = all.filter((r): r is Extract<TriageResult, { status: "ok" }> => r.status === "ok");
    // Failed calls can still be billed, so their cost counts too.
    const billed = all.flatMap((r) => ("metrics" in r && r.metrics ? [r.metrics] : []));
    const sum = (f: (r: (typeof ok)[number]) => number) => ok.reduce((n, r) => n + f(r), 0);
    return {
      done: ok.length,
      tokens: sum(
        (r) => r.metrics.inputTokens + r.metrics.cacheWriteTokens + r.metrics.cacheReadTokens + r.metrics.outputTokens,
      ),
      cacheRead: sum((r) => r.metrics.cacheReadTokens),
      cost: billed.reduce((n, m) => n + m.estCostUsd, 0),
      avgLatency: ok.length ? sum((r) => r.metrics.latencyMs) / ok.length : 0,
      flagged: ok.filter((r) => r.triage.injection_suspected).length,
      hipaa: ok.filter((r) => r.triage.hipaa.applies).length,
      crossTenant: ok.filter((r) => r.triage.multi_tenancy.cross_tenant_risk).length,
    };
  }, [rows]);

  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Security Review Queue</h1>
          <p className="sub">Each ticket is sent to Claude with a fixed system prompt and comes back as typed JSON.</p>
        </div>
        <div className="controls">
          <label className="model-picker">
            <span>Model</span>
            <select value={model} onChange={(e) => chooseModel(e.target.value)} disabled={batchRunning}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.note}
                </option>
              ))}
            </select>
          </label>
          <label className="rag-toggle">
            <input type="checkbox" checked={useRag} onChange={(e) => chooseRag(e.target.checked)} disabled={batchRunning} />
            <span>Use knowledge base (RAG)</span>
          </label>
          <button className="primary" onClick={triageAll} disabled={batchRunning || !tickets.length}>
            {batchRunning ? "Triaging…" : `Triage all ${tickets.length}`}
          </button>
        </div>
      </header>

      {loadError && <div className="error-box">{loadError}</div>}
      {batchError && <div className="error-box">{batchError}</div>}

      <section className="stats">
        <Stat label="Triaged" value={`${totals.done} / ${tickets.length}`} />
        <Stat label="Tokens" value={totals.tokens.toLocaleString()} />
        <Stat label="Cached tokens" value={totals.cacheRead.toLocaleString()} />
        <Stat label="Est. cost" value={`$${totals.cost.toFixed(3)}`} />
        <Stat label="Avg latency" value={totals.done ? `${(totals.avgLatency / 1000).toFixed(1)}s` : "–"} />
        <Stat label="HIPAA / PHI" value={String(totals.hipaa)} />
        <Stat label="Cross-tenant risk" value={String(totals.crossTenant)} warn={totals.crossTenant > 0} />
        <Stat label="Injection flags" value={String(totals.flagged)} warn={totals.flagged > 0} />
      </section>

      <main className="layout">
        <ul className="queue">
          {sorted.map((t) => {
            const r = rows[t.id];
            return (
              <li key={t.id}>
                <button
                  className={`row ${t.id === selectedId ? "selected" : ""}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <RiskBadge state={r} />
                  <span className="row-main">
                    <span className="row-title">{t.title}</span>
                    <span className="row-meta">
                      {t.id}
                      {r?.status === "ok" && ` · ${label(r.triage.request_type)} · ${r.triage.recommended_owner}`}
                      {r?.status === "error" && " · error"}
                      {(r?.status === "ok" || r?.status === "error") && r.config && ` · ${configLabel(r.config)}`}
                    </span>
                  </span>
                  {r?.status === "ok" && (
                    <span className="flags">
                      {r.triage.hipaa.applies && <span className="flag info">PHI</span>}
                      {r.triage.multi_tenancy.cross_tenant_risk && <span className="flag">tenant</span>}
                      {r.triage.injection_suspected && <span className="flag">injection</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {selected && (
          <Detail
            key={`${selected.id}:${modelQuery}`}
            ticket={selected}
            modelQuery={modelQuery}
            state={rows[selected.id]}
            onTriage={() => triageOne(selected.id)}
            disabled={batchRunning}
          />
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "warn" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function RiskBadge({ state }: { state?: RowState }) {
  if (!state || state.status === "idle") return <span className="badge pending">untriaged</span>;
  if (state.status === "running") return <span className="badge running">running</span>;
  if (state.status === "ok") return <span className={`badge ${state.triage.risk_level}`}>{state.triage.risk_level}</span>;
  return <span className="badge error">error</span>;
}

function Detail({
  ticket,
  state,
  onTriage,
  disabled,
  modelQuery,
}: {
  ticket: Ticket;
  modelQuery: string;
  state?: RowState;
  onTriage: () => void;
  disabled: boolean;
}) {
  const [prompt, setPrompt] = useState<PromptPreview | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // The preview is built locally (retrieval included), so loading it costs nothing.
  useEffect(() => {
    fetchPreview(ticket.id, modelQuery)
      .then(setPrompt)
      .catch((err: Error) => setPreviewError(`Could not load the prompt preview: ${err.message}`));
  }, [ticket.id, modelQuery]);

  // After a run, show what was actually sent; before it, show what would be retrieved.
  const retrieved = state?.status === "ok" ? state.retrieved : (prompt?.retrieved ?? null);

  const running = state?.status === "running";

  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <span className="ticket-id">{ticket.id}</span>
          <h2>{ticket.title}</h2>
          <p className="row-meta">
            {ticket.requester} · {new Date(ticket.submitted).toLocaleString()}
          </p>
        </div>
        <button onClick={onTriage} disabled={disabled || running}>
          {running ? "Triaging…" : state?.status === "ok" ? "Re-run" : "Triage"}
        </button>
      </div>

      <pre className="ticket-body">{ticket.body}</pre>

      <ContextPanel retrieved={retrieved} />

      <button className="link" onClick={() => setShowPrompt((s) => !s)}>
        {showPrompt ? "Hide" : "Show"} the prompt sent to the model
      </button>
      {previewError && <p className="row-meta">{previewError}</p>}
      {showPrompt && prompt && (
        <div className="prompt">
          <h4>model</h4>
          <pre>{prompt.model}</pre>
          <h4>system</h4>
          <pre>{prompt.system}</pre>
          <h4>user</h4>
          <pre>{prompt.user}</pre>
        </div>
      )}

      {state?.status === "error" && (
        <div className="error-box">
          {state.error}
          {state.metrics && ` (this call was still billed: ~${state.metrics.estCostUsd.toFixed(4)})`}
        </div>
      )}
      {state?.status === "ok" && <Analysis result={state} />}
    </article>
  );
}

function ContextPanel({ retrieved }: { retrieved: RetrievedChunk[] | null }) {
  if (retrieved === null) {
    return <p className="row-meta kb-off">Knowledge base off: the model sees only the ticket.</p>;
  }
  return (
    <details className="kb">
      <summary>
        Retrieved from knowledge base: {retrieved.length} {retrieved.length === 1 ? "excerpt" : "excerpts"}
      </summary>
      {retrieved.length === 0 && <p className="row-meta">No matching sections.</p>}
      {retrieved.map((c) => (
        <div className="kb-chunk" key={c.id}>
          <div className="kb-head">
            <strong>
              {c.doc} › {c.section}
            </strong>
            <span className="row-meta">score {c.score}</span>
          </div>
          <div className="row-meta">matched: {c.matchedTerms.join(", ")}</div>
          <p>{c.text}</p>
        </div>
      ))}
    </details>
  );
}

function Analysis({ result }: { result: Extract<TriageResult, { status: "ok" }> }) {
  const { triage: t, metrics: m } = result;
  return (
    <div className="analysis">
      {t.injection_suspected && (
        <div className="injection-box">
          Prompt injection suspected. The model ignored instructions embedded in the ticket.
        </div>
      )}

      <div className="fields">
        <Field label="Risk">
          <span className={`badge ${t.risk_level}`}>{t.risk_level}</span> {t.risk_reason}
        </Field>
        <Field label="Request type">{label(t.request_type)}</Field>
        <Field label="Owner">{t.recommended_owner}</Field>
        <Field label="Data sensitivity">{t.data_sensitivity}</Field>
        <Field label="STRIDE">
          {t.threat_categories.length ? (
            <span className="chips">
              {t.threat_categories.map((c) => (
                <span className="chip" key={c}>
                  {c}
                </span>
              ))}
            </span>
          ) : (
            "None"
          )}
        </Field>
        <Field label="Next step">{t.suggested_next_step}</Field>
      </div>

      {t.hipaa.applies && (
        <ConcernList title="HIPAA considerations" items={t.hipaa.concerns} />
      )}
      {(t.multi_tenancy.cross_tenant_risk || t.multi_tenancy.concerns.length > 0) && (
        <ConcernList
          title={t.multi_tenancy.cross_tenant_risk ? "Multi-tenant isolation (cross-tenant risk)" : "Multi-tenant considerations"}
          items={t.multi_tenancy.concerns}
        />
      )}

      {t.missing_info.length > 0 && (
        <>
          <h3>Missing information</h3>
          <ul className="missing">
            {t.missing_info.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}

      {result.retrieved !== null && (
        <>
          <h3>Policy references</h3>
          {t.policy_refs.length === 0 ? (
            <p className="row-meta">None of the retrieved excerpts were used.</p>
          ) : (
            <ul className="missing">
              {t.policy_refs.map((ref) => {
                const chunk = result.retrieved?.find((c) => c.id === ref.doc_id);
                return (
                  <li key={ref.doc_id}>
                    {chunk ? (
                      <strong>
                        {chunk.doc} › {chunk.section}
                      </strong>
                    ) : (
                      // A cited id that wasn't in the prompt means the model made it up.
                      <strong className="bad-ref">{ref.doc_id} (not in retrieved context)</strong>
                    )}
                    : {ref.how_used}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <h3>Draft response</h3>
      <blockquote>{t.draft_response}</blockquote>

      <p className="metrics">
        {configLabel(result.config)} · {m.model}
        {m.fallbackUsed && " (fallback)"} · {(m.latencyMs / 1000).toFixed(1)}s · {m.inputTokens} in
        {m.cacheReadTokens > 0 && ` + ${m.cacheReadTokens} cached`}
        {m.cacheWriteTokens > 0 && ` + ${m.cacheWriteTokens} written to cache`} / {m.outputTokens} out · ~$
        {m.estCostUsd.toFixed(4)}
      </p>

      <details>
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(t, null, 2)}</pre>
      </details>
    </div>
  );
}

function ConcernList({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length ? (
        <ul className="missing">
          {items.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="row-meta">Applies, but no specific concerns listed.</p>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}
