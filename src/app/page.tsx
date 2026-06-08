"use client";

import { useEffect, useMemo, useState } from "react";
import type { GrantScoutReport, Opportunity } from "@/src/lib/types";

type AgentPanel = "decision" | "evidence" | "tasks" | "drafts" | "data";

function matchScore(score: number) {
  const pct = Math.round(score * 100);
  if (pct >= 85) return { pct, label: "Apply first", tone: "prime" };
  if (pct >= 70) return { pct, label: "Strong lead", tone: "strong" };
  if (pct >= 55) return { pct, label: "Review", tone: "review" };
  return { pct, label: "Low fit", tone: "low" };
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "official source";
  }
}

function oppKey(o: Opportunity) {
  return `${o.official_link}::${o.name}`;
}

function downloadReportJson(data: unknown) {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(
    d.getMinutes()
  )}${pad2(d.getSeconds())}`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `grantscout_report_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const [narrative, setNarrative] = useState(
    "I am an international student in the US with a master's in data science. I want AI, data science, research, nonprofit, or startup grants. I need free opportunities only."
  );
  const [interests, setInterests] = useState("AI, data science, research, nonprofit, startup credits");
  const [location, setLocation] = useState("United States");
  const [status, setStatus] = useState("International student");
  const [freeOnly, setFreeOnly] = useState(true);
  const [minResults, setMinResults] = useState(10);
  const [maxRounds, setMaxRounds] = useState(4);
  const [autoDownloadJson, setAutoDownloadJson] = useState(true);
  const [query, setQuery] = useState("");
  const [onlyApply, setOnlyApply] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<AgentPanel>("decision");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GrantScoutReport | null>(null);

  const interestList = useMemo(
    () => interests.split(",").map((s) => s.trim()).filter(Boolean),
    [interests]
  );

  async function run() {
    setLoading(true);
    setError(null);
    setReport(null);
    setPanel("decision");

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          narrative,
          interests: interestList,
          location,
          status,
          free_only: freeOnly,
          min_results: minResults,
          max_search_rounds: maxRounds,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
      setReport(json);

      const first = (json?.opportunities?.[0] as Opportunity | undefined) ?? null;
      setSelectedKey(first ? oppKey(first) : null);

      const history = JSON.parse(localStorage.getItem("grantscout_history") || "[]") as any[];
      history.unshift({ at: new Date().toISOString(), input: { narrative, interestList, location, status, freeOnly }, report: json });
      localStorage.setItem("grantscout_history", JSON.stringify(history.slice(0, 10)));

      if (autoDownloadJson) downloadReportJson(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const opportunities: Opportunity[] = report?.opportunities ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return opportunities.filter((o) => {
      if (onlyApply && !o.application_link) return false;
      if (!q) return true;
      return `${o.name} ${o.type} ${o.deadline ?? ""} ${o.eligibility_reason ?? ""} ${safeHost(o.official_link)}`
        .toLowerCase()
        .includes(q);
    });
  }, [opportunities, query, onlyApply]);

  const selected = useMemo(() => {
    if (!selectedKey) return filtered[0] ?? null;
    return filtered.find((o) => oppKey(o) === selectedKey) ?? filtered[0] ?? null;
  }, [filtered, selectedKey]);

  const savedOpps = useMemo(() => {
    const keep = new Set(Object.entries(saved).filter(([, v]) => v).map(([k]) => k));
    return opportunities.filter((o) => keep.has(oppKey(o)));
  }, [opportunities, saved]);

  const agentSteps = [
    {
      title: "Understand applicant",
      detail: `${status} / ${location}`,
      state: loading || report ? "done" : "ready",
    },
    {
      title: "Plan search routes",
      detail: `${interestList.slice(0, 4).join(", ") || "No keywords"}`,
      state: loading ? "running" : report ? "done" : "ready",
    },
    {
      title: "Read official sources",
      detail: report ? `${opportunities.length} opportunities extracted` : "Waiting for mission launch",
      state: loading ? "running" : report ? "done" : "ready",
    },
    {
      title: "Rank and prepare actions",
      detail: report ? `${savedOpps.length} saved / ${filtered.length} visible` : "Checklist and drafts generated after scan",
      state: loading ? "ready" : report ? "done" : "ready",
    },
  ];

  const panels: Array<{ id: AgentPanel; label: string }> = [
    { id: "decision", label: "Decision" },
    { id: "evidence", label: "Evidence" },
    { id: "tasks", label: "Tasks" },
    { id: "drafts", label: "Drafts" },
    { id: "data", label: "Data" },
  ];

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <main className="agent-app" suppressHydrationWarning />;
  }

  return (
    <main className="agent-app">
      <section className="agent-hero">
        <div className="agent-identity">
          <span className={`agent-pulse ${loading ? "is-live" : ""}`} />
          <div>
            <p className="eyebrow">GrantScout agent</p>
            <h1>Autonomous grant scout for your profile.</h1>
          </div>
        </div>

        <div className="agent-stats" aria-label="Agent status">
          <div>
            <span>Mode</span>
            <strong>{loading ? "Working" : report ? "Complete" : "Standby"}</strong>
          </div>
          <div>
            <span>Leads</span>
            <strong>{opportunities.length || "--"}</strong>
          </div>
          <div>
            <span>Saved</span>
            <strong>{savedOpps.length || "--"}</strong>
          </div>
        </div>
      </section>

      <section className="agent-grid">
        <aside className="mission-card">
          <div>
            <p className="eyebrow">Mission brief</p>
            <h2>Tell the agent who to scout for.</h2>
          </div>

          <label className="field">
            <span>Applicant profile</span>
            <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          </label>

          <div className="signal-chips">
            {["AI", "data science", "research", "nonprofit", "startup credits"].map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setInterests(Array.from(new Set([...interestList, tag])).join(", "))}
              >
                + {tag}
              </button>
            ))}
          </div>

          <div className="brief-grid">
            <label className="field wide">
              <span>Search signals</span>
              <input value={interests} onChange={(e) => setInterests(e.target.value)} />
            </label>
            <label className="field">
              <span>Location</span>
              <input value={location} onChange={(e) => setLocation(e.target.value)} />
            </label>
            <label className="field">
              <span>Status</span>
              <input value={status} onChange={(e) => setStatus(e.target.value)} />
            </label>
          </div>

          <details className="advanced-controls">
            <summary>Agent settings</summary>
            <div>
              <label className="field">
                <span>Target leads</span>
                <input type="number" min={5} max={30} value={minResults} onChange={(e) => setMinResults(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Search rounds</span>
                <input type="number" min={1} max={10} value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))} />
              </label>
              <label className="switch-line">
                <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
                <span>Free only</span>
              </label>
              <label className="switch-line">
                <input type="checkbox" checked={autoDownloadJson} onChange={(e) => setAutoDownloadJson(e.target.checked)} />
                <span>Auto-export JSON</span>
              </label>
            </div>
          </details>

          <button className="launch-agent" type="button" onClick={run} disabled={loading}>
            {loading ? "Agent is scouting..." : "Launch agent"}
          </button>
        </aside>

        <section className="agent-console">
          <div className="console-head">
            <div>
              <p className="eyebrow">Live workbench</p>
              <h2>{loading ? "The agent is working through the mission." : report ? "Mission complete. Review decisions." : "Launch a mission to begin."}</h2>
            </div>
            <div className="console-tools">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter decisions" disabled={!report} />
              <label>
                <input type="checkbox" checked={onlyApply} onChange={(e) => setOnlyApply(e.target.checked)} />
                <span>Has apply link</span>
              </label>
              {report ? (
                <button type="button" onClick={() => downloadReportJson(savedOpps.length ? { ...report, opportunities: savedOpps } : report)}>
                  Export {savedOpps.length ? "saved" : "all"}
                </button>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="agent-error">
              <strong>Agent stopped</strong>
              <span>{error}</span>
              <small>
                If it says missing env, set <code>MISTRAL_API_KEY</code> in Vercel or <code>.env.local</code>.
              </small>
            </div>
          ) : null}

          <div className="runway">
            <div className="agent-timeline">
              {agentSteps.map((step, index) => (
                <div className={`timeline-step ${step.state}`} key={step.title}>
                  <span>{index + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="decision-stream">
              {!report ? (
                <div className="empty-agent-state">
                  <div className="scanner-mark">
                    <span />
                    <strong>Agent ready</strong>
                  </div>
                  <p>
                    When launched, GrantScout searches sources, extracts eligibility signals, ranks matches, and prepares your next actions.
                  </p>
                </div>
              ) : null}

              {report && filtered.length ? (
                filtered.map((o) => {
                  const key = oppKey(o);
                  const score = matchScore(o.eligibility_score ?? 0);
                  const isSelected = selected ? oppKey(selected) === key : false;
                  const isSaved = Boolean(saved[key]);
                  return (
                    <article className={`decision-card ${score.tone} ${isSelected ? "selected" : ""}`} key={key}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedKey(key);
                          setPanel("decision");
                        }}
                      >
                        <span className="decision-score">{score.pct}</span>
                        <span className="decision-label">{score.label}</span>
                        <strong>{o.name}</strong>
                        <small>{o.type} / {safeHost(o.official_link)}</small>
                        <p>{o.eligibility_reason || "The agent found this lead, but no summary was extracted."}</p>
                        <span className="deadline">{o.deadline || "No deadline found"}</span>
                      </button>
                      <div className="decision-actions">
                        <button type="button" className={isSaved ? "is-saved" : ""} onClick={() => setSaved((cur) => ({ ...cur, [key]: !cur[key] }))}>
                          {isSaved ? "Saved" : "Save"}
                        </button>
                        <a href={o.official_link} target="_blank" rel="noreferrer">Source</a>
                        {o.application_link ? <a href={o.application_link} target="_blank" rel="noreferrer">Apply</a> : null}
                      </div>
                    </article>
                  );
                })
              ) : null}

              {report && !filtered.length ? <p className="muted-copy">No decisions match the current filters.</p> : null}
            </div>
          </div>
        </section>

        <aside className="decision-panel">
          <div className="panel-tabs">
            {panels.map((p) => (
              <button key={p.id} type="button" className={panel === p.id ? "active" : ""} disabled={!report && p.id !== "decision"} onClick={() => setPanel(p.id)}>
                {p.label}
              </button>
            ))}
          </div>

          {panel === "decision" ? (
            selected ? (
              <div className="panel-body">
                <div className="agent-verdict">
                  <span>{matchScore(selected.eligibility_score ?? 0).pct}%</span>
                  <strong>{matchScore(selected.eligibility_score ?? 0).label}</strong>
                </div>
                <h3>{selected.name}</h3>
                <p>{selected.eligibility_reason || "No eligibility summary extracted."}</p>
                <div className="panel-actions">
                  <a href={selected.official_link} target="_blank" rel="noreferrer">Official source</a>
                  {selected.application_link ? <a href={selected.application_link} target="_blank" rel="noreferrer">Apply now</a> : null}
                </div>
                <section>
                  <h4>Agent recommendation</h4>
                  <p>
                    {selected.application_link
                      ? "Open the application link, verify the deadline, and reuse the generated checklist before drafting."
                      : "Verify the official source first. The agent did not find a direct application link for this lead."}
                  </p>
                </section>
              </div>
            ) : (
              <div className="panel-empty">
                <strong>No decision selected</strong>
                <span>Launch the agent or select a result to see the verdict.</span>
              </div>
            )
          ) : null}

          {panel === "evidence" && selected ? (
            <div className="panel-body">
              <h3>Evidence trail</h3>
              {(selected.evidence || []).length ? (
                <div className="evidence-list">
                  {(selected.evidence || []).slice(0, 6).map((ev) => (
                    <div key={ev.url + ev.quote}>
                      <small>{ev.url}</small>
                      <p>"{ev.quote}"</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No evidence quotes were extracted for this opportunity.</p>
              )}
              <section>
                <h4>Requirements</h4>
                {selected.requirements?.length ? (
                  <ul>{selected.requirements.slice(0, 10).map((r) => <li key={r}>{r}</li>)}</ul>
                ) : (
                  <p>No requirements extracted.</p>
                )}
              </section>
            </div>
          ) : null}

          {panel === "tasks" && report ? (
            <div className="panel-body">
              <h3>Next actions</h3>
              <ul>{report.checklist.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}

          {panel === "drafts" && report ? (
            <div className="panel-body">
              <h3>Draft pack</h3>
              {Object.entries(report.drafts).map(([key, value]) => (
                <div className="draft-block" key={key}>
                  <strong>{key}</strong>
                  <pre>{value}</pre>
                </div>
              ))}
            </div>
          ) : null}

          {panel === "data" && report ? (
            <div className="panel-body">
              <h3>Agent output</h3>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
