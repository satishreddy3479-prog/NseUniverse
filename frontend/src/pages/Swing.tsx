import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, api } from "../lib/api";
import { fmtDateTimeIST } from "../lib/format";
import { BASIS_LABEL, isStale, reportAgeDays, type Basis } from "../lib/swing";
import { EmptyState, ErrorNote, Panel, Skeleton } from "../components/ui";
import { SwingOverview } from "../components/swing/SwingOverview";
import { SwingMinutePanel } from "../components/swing/SwingMinutePanel";
import { SwingPaper, type RunNote } from "../components/swing/SwingPaper";
import { SwingRobustness } from "../components/swing/SwingRobustness";
import { SwingRules } from "../components/swing/SwingRules";
import { RoleBanner, SwingModes } from "../components/swing/SwingModes";
import type { BacktestSub, SwingMode, TopTab } from "../lib/swingModes";
import { SwingTrades } from "../components/swing/SwingTrades";
import { TabPanel, Tabs, type TabDef } from "../components/swing/shared";
import type { SwingReport } from "../lib/types";

// Four sections, one question each: the official paper book, the live paper book (a separate portfolio), the backtest of the past, and the rules behind all of them.
const TABS: TabDef[] = [
  { id: "paper", label: "Official paper book" },
  { id: "live", label: "Live paper book" },
  { id: "backtest", label: "Backtest (history)" },
  { id: "rules", label: "Rules & limits" },
];
const BACKTEST_TABS: TabDef[] = [
  { id: "results", label: "Results" },
  { id: "trades", label: "Trades" },
  { id: "robustness", label: "Robustness" },
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
  const [tab, setTab] = useState<TopTab>("paper");
  const [btSub, setBtSub] = useState<BacktestSub>("results");
  const openMode = (m: SwingMode) => { setTab(m.tab); if (m.tab === "backtest" && m.sub) setBtSub(m.sub as BacktestSub); };
  const [basis, setBasis] = useState<Basis>("net");
  const qc = useQueryClient();
  // while a scan runs, follow its progress every 3 seconds; otherwise every 5 minutes
  const paper = useQuery({
    queryKey: ["swing-paper"], queryFn: api.swingPaper, staleTime: 30_000, retry: false,
    refetchInterval: (q) => (q.state.data?.status.running ? 3_000 : 5 * 60_000),
  });
  const [runNote, setRunNote] = useState<RunNote | null>(null);
  const live = useQuery({ queryKey: ["swing-live"], queryFn: api.swingLive, refetchInterval: 5_000, retry: false, enabled: tab === "paper" });
  const run = useMutation({
    mutationFn: api.swingRun,
    onSuccess: (r) => {
      setRunNote({ kind: "info", text: r.started ? "Scan started. This page follows its progress and updates by itself." : "A scan is already running." });
      void qc.invalidateQueries({ queryKey: ["swing-paper"] });
    },
    onError: (e) => setRunNote({ kind: "error", text: `Could not start the scan: ${e instanceof Error ? e.message : "unknown error"}` }),
  });
  const report = useQuery({ queryKey: ["swing-report"], queryFn: api.swingReport, staleTime: 60_000, retry: false, enabled: tab === "backtest" || tab === "rules" });
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

      <SwingModes onOpen={openMode} current={tab === "paper" ? "official" : tab === "live" ? "live" : tab === "backtest" ? "backtest" : null} />

      <Tabs tabs={TABS} value={tab} onChange={(t) => setTab(t as TopTab)} label="Swing trading sections" />

      {tab === "paper" && (
        <TabPanel id="paper">
          <RoleBanner role="official">The positions, trades and equity below are the official paper book. A buy is booked only in the evening run (after 17:00 IST), judged on the whole day; after the close the scan hands the same candidate list to the Live paper book too, but that book is a separate portfolio and never changes this one.</RoleBanner>
          {paper.isPending ? <Loading what="the paper book" />
            : paper.isError ? <ErrorNote title="Could not load the paper book" message={paper.error instanceof Error ? paper.error.message : "Unknown error"} />
              : <SwingPaper view={paper.data} liveRows={live.data?.watching} market={live.data?.market} runPending={run.isPending} runNote={runNote} onRun={() => run.mutate()} />}
        </TabPanel>
      )}
      {tab === "live" && (
        <TabPanel id="live">
          <RoleBanner role="live">The same rules run live, with its own cash, positions, stops, targets, trades and equity curve. After the close it gets the same candidate list as the official book, then works only on its own rules and portfolio: nothing here is held in, or changes, the official book.</RoleBanner>
          <SwingMinutePanel />
        </TabPanel>
      )}
      {tab === "backtest" && (
        <TabPanel id="backtest">
          <RoleBanner role="history">The daily rules replayed over past data, built on the research PC. It shows what the rules would have done, with and without costs; it is not live and not a forecast.</RoleBanner>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Tabs tabs={BACKTEST_TABS} value={btSub} onChange={(t) => setBtSub(t as BacktestSub)} label="Backtest views" />
              {btSub === "results" && report.data && (
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
            {btSub === "results" && <TabPanel id="results">{withReport((r) => <SwingOverview report={r} basis={basis} />)}</TabPanel>}
            {btSub === "trades" && <TabPanel id="trades">{withReport((r) => <SwingTrades report={r} />)}</TabPanel>}
            {btSub === "robustness" && <TabPanel id="robustness">{withReport((r) => <SwingRobustness report={r} />)}</TabPanel>}
          </div>
        </TabPanel>
      )}
      {tab === "rules" && <TabPanel id="rules">{withReport((r) => <SwingRules report={r} config={paper.data?.config} />)}</TabPanel>}
    </div>
  );
}
