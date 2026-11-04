import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, api } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import { BASIS_LABEL, isStale, reportAgeDays, type Basis } from "../lib/swing";
import { EmptyState, ErrorNote, Panel, Skeleton } from "../components/ui";
import { SwingOverview } from "../components/swing/SwingOverview";
import { SwingPaper } from "../components/swing/SwingPaper";
import { SwingRobustness } from "../components/swing/SwingRobustness";
import { SwingRules } from "../components/swing/SwingRules";
import { SwingTrades } from "../components/swing/SwingTrades";
import { TabPanel, Tabs, type TabDef } from "../components/swing/shared";
import type { SwingReport } from "../lib/types";

const TABS: TabDef[] = [
  { id: "paper", label: "Paper trading" },
  { id: "overview", label: "Backtest" },
  { id: "trades", label: "Backtest trades" },
  { id: "robustness", label: "Robustness" },
  { id: "rules", label: "Rules & limits" },
];

function Loading({ what }: { what: string }) {
  return <Panel title={`Loading ${what}`}><p className="flex items-center gap-2 text-sm text-muted"><Skeleton className="h-4 w-40" /> Reading the stored data…</p></Panel>;
}

function Failed({ error, missing }: { error: unknown; missing: ReactNode }) {
  if (error instanceof ApiError && error.code === "swing_report_missing") return <>{missing}</>;
  return <ErrorNote title="Could not load this section" message={error instanceof Error ? error.message : "Unknown error"} />;
}

const MISSING_REPORT = (
  <Panel title="No backtest report on this machine">
    <EmptyState title="The backtest has not been published here">
      <p>It is built on the research PC by <code>scripts\swing-refresh.ps1</code> (about 5 minutes) and written to <code>data\swing\report.json</code>. Copy that one file to the server&apos;s <code>data/swing/</code> folder to show it here. Paper trading above does not need it.</p>
    </EmptyState>
  </Panel>
);

export default function Swing() {
  const [tab, setTab] = useState("paper");
  const [basis, setBasis] = useState<Basis>("net");
  const paper = useQuery({ queryKey: ["swing-paper"], queryFn: api.swingPaper, staleTime: 30_000, refetchInterval: 5 * 60_000, retry: false });
  const report = useQuery({ queryKey: ["swing-report"], queryFn: api.swingReport, staleTime: 60_000, retry: false, enabled: tab !== "paper" });
  const withReport = (render: (r: SwingReport) => ReactNode) =>
    report.isPending ? <Loading what="the backtest report" />
      : report.isError ? <Failed error={report.error} missing={MISSING_REPORT} />
        : render(report.data);
  const through = paper.data?.book.as_of ?? null;

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Swing trading</h1>
          <p className="max-w-[70ch] text-sm text-muted">
            Breakout engine on NSE daily bars: Chartink quality universe, market and sector gates, a 0-100 setup score, strict
            day-1 cuts and a trailing stop. It scans after every close and paper-trades the rules automatically; no real orders are placed.
          </p>
        </div>
        {through && (
          <p className="num text-left text-xs text-muted sm:text-right">
            Paper book through the close of {through}
            {isStale(through) && <span className="ml-2 rounded-sm border border-warn/60 px-1.5 py-px text-warn">Stale · {reportAgeDays(through)} days old</span>}
            {report.data && <><br />Backtest report built {fmtDateTimeIST(report.data.meta.generated_at_utc)}</>}
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Swing trading sections" />
        {tab === "overview" && report.data && (
          <div role="group" aria-label="Show results" className="flex overflow-hidden rounded-sm border border-rule text-sm">
            {(["net", "gross"] as Basis[]).map((b) => (
              <button key={b} type="button" aria-pressed={basis === b} onClick={() => setBasis(b)}
                className={`min-h-9 px-3 ${basis === b ? "bg-brass/20 font-medium text-paper" : "bg-slate-2 text-muted hover:text-paper"}`}>
                {BASIS_LABEL[b]}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === "paper" && (
        <TabPanel id="paper">
          {paper.isPending ? <Loading what="the paper book" />
            : paper.isError ? <ErrorNote title="Could not load the paper book" message={paper.error instanceof Error ? paper.error.message : "Unknown error"} />
              : <SwingPaper view={paper.data} />}
        </TabPanel>
      )}
      {tab === "overview" && <TabPanel id="overview">{withReport((r) => <SwingOverview report={r} basis={basis} />)}</TabPanel>}
      {tab === "trades" && <TabPanel id="trades">{withReport((r) => <SwingTrades report={r} />)}</TabPanel>}
      {tab === "robustness" && <TabPanel id="robustness">{withReport((r) => <SwingRobustness report={r} />)}</TabPanel>}
      {tab === "rules" && <TabPanel id="rules">{withReport((r) => <SwingRules report={r} />)}</TabPanel>}
    </div>
  );
}
