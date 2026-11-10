import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { Info } from "../components/Info";
import { DashProvider, type Range } from "../components/dashboard/DashContext";
import { WIDGETS } from "../components/dashboard/widgets";
import { MultiStrikeBoard, PriceOiBoard } from "../components/dashboard/PriceBoards";
import { VegaAnalysisBoard } from "../components/dashboard/VegaAnalysis";
import { GammaAnalysisBoard } from "../components/dashboard/GammaAnalysis";
import { StreamButtons } from "../components/LiveActivity";
import { IndexToolBody } from "../components/IndexTools";
import { FlowsPanel } from "../components/FlowsPanel";
import { CashPanel } from "../components/CashPanel";
import { FuturesFlowBody } from "../components/FuturesFlowTools";
import { FuturesBuildupBody } from "../components/FuturesBuildupTool";
import { IvChartBody } from "../components/IvChartPages";
import { SignalBacktestBody } from "../components/SignalBacktest";
import { MarketStructureBody } from "../components/MarketStructure";
import { StrikePositioningBody } from "../components/StrikePositioning";
import { IvMomentumBody } from "../components/IvMomentum";
import { IvSkewBody } from "../components/IvSkew";
import { IvHvBody, IvIntradayBody } from "../components/IvTools";
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
  const [mode, setModeState] = useState<Mode>("weekly");
  const chose = useRef(false); // true once the user has picked an expiry themselves: the page then never changes it for them
  const setMode = (m: Mode) => { chose.current = true; setModeState(m); };
  const [manual, setManual] = useState("");
  const [range, setRange] = useState<Range>(10);
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  // The new weekly expiry has no stored session until the sampler has run through one (the old weekly expires and the next is only
  // sampled from its own first session), so on the morning after an expiry, or on a holiday, the weekly shows nothing. Until the user
  // picks an expiry the page opens on the monthly, which has the last session's samples, and says why.
  const last = exp?.last_session;
  const fellBack = !!exp && !chose.current && mode === "weekly" && !!exp.weekly && !!exp.monthly && last != null && !last[exp.weekly] && !!last[exp.monthly];
  useEffect(() => { if (fellBack) setModeState("monthly"); }, [fellBack]);
  const showingFallback = !!exp && !chose.current && mode === "monthly" && !!exp.weekly && !!exp.monthly && last != null && !last[exp.weekly] && !!last[exp.monthly];
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

  const usesChain = !!tool.widgets || !!tool.board || tool.page === "futflow" || tool.page === "futsectors" || tool.page === "ivhv" || tool.page === "ivchart" || tool.page === "ivskew" || tool.page === "ivmomentum" || tool.page === "backtest" || tool.page === "strikepos" || tool.page === "marketstructure" || tool.page === "ivintraday";
  const strikeControls = !tool.board && tool.page !== "futflow" && tool.page !== "futsectors" && tool.page !== "ivhv" && tool.page !== "ivchart" && tool.page !== "ivskew" && tool.page !== "ivmomentum" && tool.page !== "strikepos" && tool.page !== "backtest" && tool.page !== "marketstructure" && tool.page !== "ivintraday"; // the boards pick their own strikes; these pages have no strike range
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
            {showingFallback && exp?.weekly && exp.monthly && last && (
              <p className="basis-full text-xs text-warn" role="status" data-testid="expiry-fallback">
                Weekly {fmtExpiry(exp.weekly)} has no stored session yet (the sampler stores an expiry from its own first session), so this opened on the monthly {fmtExpiry(exp.monthly)}: its last stored session is {last[exp.monthly]}. Pick Weekly to see the weekly anyway.
              </p>
            )}
            {strikeControls && <label className="flex items-center gap-2 text-sm text-muted">
              Strikes around ATM
              <select aria-label="Strike range" value={String(range)} onChange={(e) => setRange(e.target.value === "all" ? "all" : Number(e.target.value))} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
                {RANGES.map((n) => <option key={String(n)} value={String(n)}>{n === "all" ? "All" : `±${n}`}</option>)}
              </select>
            </label>}
            {strikeControls && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)} className="accent-[var(--brass)]" /> Calls</label>}
            {strikeControls && <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)} className="accent-[var(--brass)]" /> Puts</label>}
          </div>
        )}
        {tool.widgets && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12" data-testid="tool-widgets">
            {tool.widgets.map((wid) => {
              const w = WIDGETS.find((x) => x.id === wid);
              if (!w) return null;
              // small widgets (the registry's width is out of 12) sit two to a row at a compact height; wide ones keep the full width
              const half = w.w <= 6;
              return (
                <section key={wid} aria-label={w.title}
                  style={wid === "chain" ? undefined : ({ "--chart-h": `${w.w <= 4 ? 260 : Math.max(300, w.h * 40 - 100)}px` } as CSSProperties)}
                  className={`flex flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate ${wid === "chain" ? "" : "widget-stacked"} ${half ? "md:col-span-6" : "md:col-span-12"}`}>
                  <header className="flex min-h-9 items-center border-b border-rule px-3"><h2 className="flex items-center gap-1.5 text-sm font-semibold text-paper">{w.title}<Info term={w.title} /></h2></header>
                  <div className="p-2" style={wid === "chain" ? { height: Math.max(340, w.h * 40) } : undefined}>{w.render()}</div>
                </section>
              );
            })}
          </div>
        )}
        {tool.board === "vega" && <VegaAnalysisBoard />}
        {tool.board === "gamma" && <GammaAnalysisBoard />}
        {tool.board === "priceOi" && <PriceOiBoard />}
        {tool.board === "multiStrike" && <MultiStrikeBoard straddle={false} />}
        {tool.board === "multiStraddle" && <MultiStrikeBoard straddle />}
        {tool.page === "flows" && <FlowsPanel />}
        {tool.page === "cash" && <CashPanel />}
        {tool.page === "futflow" && <FuturesFlowBody expiry={expiry} part="flow" />}
        {tool.page === "futsectors" && <FuturesFlowBody expiry={expiry} part="sectors" />}
        {tool.page === "futbuildup" && <FuturesBuildupBody />}
        {tool.page === "ivhv" && <IvHvBody expiry={expiry} />}
        {tool.page === "ivintraday" && <IvIntradayBody expiry={expiry} />}
        {tool.page === "ivchart" && <IvChartBody />}
        {tool.page === "ivskew" && <IvSkewBody expiry={expiry} />}
        {tool.page === "ivmomentum" && <IvMomentumBody expiry={expiry} />}
        {tool.page === "strikepos" && <StrikePositioningBody expiry={expiry} />}
        {tool.page === "marketstructure" && <MarketStructureBody expiry={expiry} />}
        {tool.page === "backtest" && <SignalBacktestBody expiry={expiry} />}
        {tool.page && tool.page !== "flows" && tool.page !== "cash" && tool.page !== "futflow" && tool.page !== "futsectors" && tool.page !== "futbuildup" && tool.page !== "ivhv" && tool.page !== "ivchart" && tool.page !== "ivskew" && tool.page !== "ivmomentum" && tool.page !== "strikepos" && tool.page !== "marketstructure" && tool.page !== "backtest" && tool.page !== "ivintraday" && <IndexToolBody page={tool.page} />}
      </div>
    </DashProvider>
  );
}
