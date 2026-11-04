import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Info } from "../components/Info";
import { DashProvider, type Range } from "../components/dashboard/DashContext";
import { WIDGETS } from "../components/dashboard/widgets";
import { StreamButtons } from "../components/LiveActivity";
import { IndexToolBody } from "../components/IndexTools";
import { FlowsPanel } from "../components/FlowsPanel";
import { CashPanel } from "../components/CashPanel";
import { fmtExpiry } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { toolById, toolPath } from "../lib/tools";

type Mode = "weekly" | "monthly" | "manual";
const RANGES: Range[] = [5, 10, 20, "all"];

/** One tool: its own heading, the same expiry / strike-range controls as the analysis page, and its charts at full width. */
export default function ToolPage() {
  const { id } = useParams();
  const tool = toolById(id);
  const exp = useExpiries().data;
  const [mode, setMode] = useState<Mode>("weekly");
  const [manual, setManual] = useState("");
  const [range, setRange] = useState<Range>(10);
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  const expiry = mode === "weekly" ? exp?.weekly ?? null : mode === "monthly" ? exp?.monthly ?? null : manual || exp?.available[0] || null;

  if (!tool) return <p className="text-muted">There is no such tool. <Link className="text-info underline" to="/">See all tools</Link>.</p>;
  if (!toolPath(tool))
    return (
      <div className="mx-auto max-w-[760px]">
        <h1 className="text-xl font-semibold">{tool.label}</h1>
        <p className="mt-2 text-sm text-muted">{tool.blurb}</p>
        <p className="mt-4 rounded-sm border border-rule bg-slate p-3 text-sm">Planned, not built yet. {tool.needs}</p>
        <Link className="mt-3 inline-block text-sm text-info underline" to="/">Back to all tools</Link>
      </div>
    );

  const usesChain = !!tool.widgets;
  const modeBtn = (m: Mode, label: string, date?: string | null) => (
    <button type="button" key={m} aria-pressed={mode === m} disabled={m !== "manual" && !date} onClick={() => setMode(m)}
      className={`min-h-9 rounded-sm border px-3 text-sm disabled:opacity-40 ${mode === m ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>
      {label}{date ? <span className="ml-1.5 text-xs text-muted">{fmtExpiry(date)}</span> : null}
    </button>
  );

  return (
    <DashProvider expiry={expiry} range={range} showCalls={showCalls} showPuts={showPuts}>
      <div className="mx-auto flex max-w-[1700px] flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">{tool.label}<Info term={tool.label} /></h1>
            <p className="text-sm text-muted">{tool.blurb}</p>
          </div>
          {usesChain && <StreamButtons />}
        </div>
        {usesChain && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
            <span className="text-sm font-semibold">NIFTY</span>
            <div role="group" aria-label="Expiry" className="flex flex-wrap items-center gap-2">
              {modeBtn("weekly", "Weekly", exp?.weekly)}
              {modeBtn("monthly", "Monthly", exp?.monthly)}
              {modeBtn("manual", "Other")}
              {mode === "manual" && (
                <select aria-label="Choose expiry" value={manual || exp?.available[0] || ""} onChange={(e) => setManual(e.target.value)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm">
                  {exp?.available.map((x) => <option key={x} value={x}>{fmtExpiry(x)}</option>)}
                </select>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              Strikes around ATM
              <select aria-label="Strike range" value={String(range)} onChange={(e) => setRange(e.target.value === "all" ? "all" : Number(e.target.value))} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
                {RANGES.map((n) => <option key={String(n)} value={String(n)}>{n === "all" ? "All" : `±${n}`}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)} className="accent-[var(--brass)]" /> Calls</label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)} className="accent-[var(--brass)]" /> Puts</label>
          </div>
        )}
        {tool.widgets?.map((wid) => {
          const w = WIDGETS.find((x) => x.id === wid);
          return w ? (
            <section key={wid} aria-label={w.title} className="flex flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
              <header className="flex min-h-9 items-center border-b border-rule px-3"><h2 className="flex items-center gap-1.5 text-sm font-semibold text-paper">{w.title}<Info term={w.title} /></h2></header>
              <div className="p-2" style={{ height: Math.max(340, w.h * 40) }}>{w.render()}</div>
            </section>
          ) : null;
        })}
        {tool.page === "flows" && <FlowsPanel />}
        {tool.page === "cash" && <CashPanel />}
        {tool.page && tool.page !== "flows" && tool.page !== "cash" && <IndexToolBody page={tool.page} />}
      </div>
    </DashProvider>
  );
}
