import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { api } from "../../lib/api";
import { minuteAligned } from "../../lib/refresh";
import { sessionOpenMin } from "../../lib/session";
import { strikesAround } from "../../lib/optionTools";
import type { SmartOiResult } from "../../lib/optionTools";
import {
  alignFuture, analyseSmartOi, buildStrikeFlow, collapseBursts, INDICATOR_NAMES, TH, type Burst, type DivergenceReport, type Direction, type Signal,
} from "../../lib/smartOiDivergence";
import type { ChartColors } from "../../lib/chartOptions";
import { EChart, useChartColors } from "../EChart";
import { useClipped } from "./ReplayContext";

export const DIVERGENCE_TIMEFRAMES = [3, 5] as const;
const arrow = (d: Direction) => (d === "bullish" ? "▲" : d === "bearish" ? "▼" : "●");
const tone = (d: Direction) => (d === "bullish" ? "text-up" : d === "bearish" ? "text-down" : "text-muted");
const gradeTip: Record<string, string> = { A: "clean candles in the window", B: "one or two candles in the window are flagged (a gap, a changed strike count, a stand-in price)", C: "three or more flagged candles, or the index feed stalled today: read with care" };

/**
 * Divergences between price and the positioning behind Smart OI (lib/smartOiDivergence.ts): the seven indicators and their agreement, the signals on
 * a price line, and what each one means. Shown for 3 and 5 minute candles. The per-strike series (who is writing, where) and the NIFTY future are
 * fetched beside the Smart OI totals; an indicator whose input is missing says so and stays silent.
 */
export function SmartOiDivergence({ res, tf, since, expiry, listed, openAtm }: { res: SmartOiResult | null; tf: number; since: string | undefined; expiry: string | null; listed: number[]; openAtm: number | null }) {
  const colors = useChartColors();
  const on = (DIVERGENCE_TIMEFRAMES as readonly number[]).includes(tf);
  const strikeKey = useMemo(() => (openAtm == null ? "" : strikesAround(listed, openAtm, 21).join(",")), [listed, openAtm]);
  const sq = useQuery({
    queryKey: ["smartOiDivStrikes", expiry, strikeKey, since],
    queryFn: () => api.strikeSeries(expiry!, strikeKey, since),
    enabled: on && !!expiry && !!since && !!strikeKey, refetchInterval: minuteAligned, retry: false, placeholderData: keepPreviousData,
  });
  const fq = useQuery({ queryKey: ["smartOiDivFuture", since], queryFn: () => api.futuresSeries(since), enabled: on && !!since, refetchInterval: minuteAligned, retry: false });
  const ss = useClipped(sq.data);
  const fut = useClipped(fq.data);
  const report: DivergenceReport | null = useMemo(() => {
    if (!on || !res || res.candles.length < 4) return null;
    const flow = ss ? buildStrikeFlow(res, ss, sessionOpenMin()) : undefined;
    return analyseSmartOi(res, { strikeFlow: flow, future: fut ? alignFuture(res, fut) : undefined });
  }, [on, res, ss, fut]);
  const bursts = useMemo(() => (report ? collapseBursts(report.signals) : []), [report]);
  const option = useMemo(() => (res && report ? markerOption(res, report, bursts, colors) : null), [res, report, bursts, colors]);

  if (!on) {
    return <p className="rounded-sm border border-rule bg-slate-2 px-3 py-2 text-sm text-muted" data-testid="div-off">Divergence indicators are built for 3 and 5 minute candles. Choose 3 min or 5 min above to see them.</p>;
  }
  if (!res || !report) {
    return <p className="rounded-sm border border-rule bg-slate-2 px-3 py-2 text-sm text-muted" data-testid="div-wait">Divergences need at least four {tf}-minute candles of stored samples.</p>;
  }
  const c = report.composite;
  const recent = [...bursts].reverse().slice(0, 14);
  return (
    <section aria-label="Divergence indicators" className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="divergence">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-paper">Divergence indicators <span className="text-xs font-normal text-muted">· {tf}-minute candles · indicator, not validated</span></h3>
          <p className={`text-sm font-semibold ${tone(c.direction)}`} data-testid="div-composite">{arrow(c.direction)} {c.text}</p>
          <p className="mt-0.5 text-xs text-muted" data-testid="div-contrarian">A divergence is a disagreement with price. A bullish one during a fall means something under the fall is turning up; a bearish one during a rise means the rise is losing support. It is a warning to look closer, not a forecast of direction.</p>
        </div>
        <span className="rounded-full border border-rule bg-slate-2 px-3 py-1 text-xs font-semibold text-paper" title={gradeTip[c.grade]} data-testid="div-grade">Evidence {c.grade}<span className="ml-1 font-normal text-muted">{gradeTip[c.grade]!.split(" (")[0]}</span></span>
      </header>
      <ul className="grid gap-2 md:grid-cols-2" data-testid="div-readings">
        {report.readings.map((r) => (
          <li key={r.id} className={`rounded-sm border px-3 py-2 ${r.active ? "border-rule bg-slate-2" : "border-rule/60"}`} data-testid={`div-${r.id}`} data-active={r.active ? "true" : "false"}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-paper">{INDICATOR_NAMES[r.id]}</span>
              {r.active ? <span className={`num text-sm font-semibold ${tone(r.direction)}`}>{arrow(r.direction)} {r.direction} divergence · {Math.round(r.strength * 100)}% · {r.at}</span> : <span className="text-xs text-muted">quiet</span>}
            </div>
            <p className={`mt-0.5 text-xs ${r.active ? "text-paper" : "text-muted"}`}>{r.text}</p>
            {r.active && <div className="mt-1 h-1 overflow-hidden rounded-full bg-rule" aria-hidden><div className={`h-full ${r.direction === "bullish" ? "bg-up" : r.direction === "bearish" ? "bg-down" : "bg-muted"}`} style={{ width: `${Math.round(r.strength * 100)}%` }} /></div>}
          </li>
        ))}
      </ul>
      {option && (
        <div>
          <EChart className="echart-fixed !h-[300px]" hoverGroup="smart-oi" option={option} ariaLabel="NIFTY close with the divergence signals marked" />
          <p className="mt-1 text-xs text-muted" data-testid="div-chart-note">
            <span className="text-up">▲</span> under the price line: something other than price leans bullish, <span className="text-down">▼</span> above it: bearish, <span>●</span> a notable reading with no direction. One marker is the <b>start</b> of a run of the same signal (hover it for how long it lasted and why). One marker per candle: when several indicators start on the same candle they share one marker (hover to list them), and when they disagree it is a neutral dot. A hollow marker failed.
          </p>
        </div>
      )}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Signals today, newest first</h4>
        {recent.length === 0 ? <p className="text-sm text-muted" data-testid="div-none">No divergence signal has formed today on {tf}-minute candles.</p> : (
          <ul className="flex flex-col gap-1" data-testid="div-events">
            {recent.map((s, k) => (
              <li key={`${s.id}-${s.i}-${k}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="num text-muted">{s.at}{s.count > 1 ? `–${s.lastAt}` : ""}</span>
                <span className={`font-semibold ${tone(s.direction)}`}>{arrow(s.direction)} {INDICATOR_NAMES[s.id]}</span>
                {s.count > 1 && <span className="rounded-sm border border-rule px-1 text-[11px] text-muted" title={`The same signal held for ${s.count} candles in a row`}>×{s.count}</span>}
                {s.state === "failed" && <span className="rounded-sm border border-warn/50 px-1 text-[11px] text-warn" title="Price later went beyond the swing the signal was built on">failed</span>}
                <span className="text-muted">{s.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="text-xs text-muted" data-testid="div-notes">
        <summary className="cursor-pointer text-info">How to read these, and what they cannot tell you</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li><b>Flow</b>: at confirmed swing highs and lows (a swing needs {TH.pivotK[tf] ?? 2} candles each side, so it is known {TH.pivotK[tf] ?? 2} candles late) price and the day's cumulative Smart OI are compared. Regular: they disagree about the new extreme. Hidden: price makes a smaller extreme while flow makes a larger one. Failed: price later went beyond the swing.</li>
          <li><b>Writing or buying</b>: each strike's OI change read with its premium change after taking out what the index move explains (each premium is re-priced for the new index level and the time that passed; what the whole chain did together, a forward shift and a volatility move, is fitted and removed, so only what a strike did on its own counts). OI up with the premium down is writing, up with the premium up is buying; OI down with the premium up is covering, down with the premium down is unwinding. Two candles in a row where this contradicts the Smart OI label.</li>
          <li><b>Conviction</b>: new OI per option contract traded against the day's usual level. A move with plenty of volume and little new OI is churn; new OI building without a move is absorption.</li>
          <li><b>PCR</b>: what is held (OI PCR) against what is traded (volume PCR) and against price over {TH.windowMin} minutes.</li>
          <li><b>Future against options</b>: the future's price and OI (long build-up, short build-up, short covering, long unwinding) against the direction of Smart OI over {TH.windowMin} minutes.</li>
          <li><b>Zone</b>: put OI added below spot against call OI added above it, against price. Price rising into a growing ceiling or falling onto a growing floor.</li>
          <li><b>Momentum</b>: the smoothed speed of Smart OI against price over {TH.windowMin} minutes, and readings that are unusual for this day (robust z-score of {TH.momZ} or more).</li>
          <li><b>Composite</b>: a direction needs {TH.composite.minAgree} indicators agreeing and a lead of {TH.composite.minLead} over the other side, each active within the last {TH.windowMin} minutes.</li>
          <li>Smart OI is built from stored one-minute samples (a candle's change is a difference of two samples). The per-strike indicators use ATM ±10 strikes of the day's opening at-the-money strike. A divergence says price and positioning disagree, not which one is right. The thresholds are provisional and are being tested on stored sessions; nothing here is an order or a target.</li>
        </ul>
      </details>
      {(report.missing.strikes || report.missing.future) && (
        <p className="text-xs text-muted" data-testid="div-missing">{report.missing.strikes ? "The stored per-strike series is not available: writing or buying and zone are silent. " : ""}{report.missing.future ? "The stored NIFTY future series is not available: the future indicator is silent." : ""}</p>
      )}
    </section>
  );
}

/** The price line with one marker per signal: triangles up (bullish) and down (bearish), a dot for neutral, a hollow marker once a flow divergence failed, and a dashed line between the two swings of a flow divergence. */
/** Signals that start on the same candle become one marker: the direction they share, or neutral when they disagree. */
export function markerGroups(bursts: Burst[]): { direction: Direction; lead: Burst; all: Burst[] }[] {
  const by = new Map<number, Burst[]>();
  for (const b of bursts) by.set(b.i, [...(by.get(b.i) ?? []), b]);
  return [...by.values()].map((all) => {
    const dirs = new Set(all.map((x) => x.direction).filter((d) => d !== "neutral"));
    const direction: Direction = dirs.size === 1 ? [...dirs][0]! : "neutral";
    return { direction, lead: all.find((x) => x.direction === direction) ?? all[0]!, all };
  });
}
function markerOption(res: SmartOiResult, rep: DivergenceReport, bursts: Burst[], c: ChartColors): EChartsCoreOption {
  const labels = res.candles.map((x) => x.label);
  const close = res.candles.map((x) => x.spot?.close ?? null);
  const at = (s: Signal) => close[s.i] ?? null;
  // bullish markers sit just under the price line and bearish ones just above it, so they never cover the line; one marker per burst
  // one marker per candle: signals starting on the same candle are merged (the tooltip lists them all); when they disagree the marker is neutral
  const groups = markerGroups(bursts).filter((g) => at(g.lead) != null);
  const mark = (dir: Direction, symbol: string, color: string, dy: number) => ({
    name: dir, type: "scatter", symbol, symbolSize: 10, symbolOffset: [0, dy], itemStyle: { color }, z: 5,
    data: groups.filter((g) => g.direction === dir).map((g) => ({ value: [g.lead.i, at(g.lead)], signal: g.lead, all: g.all, itemStyle: g.lead.state === "failed" && g.all.length === 1 ? { color: "transparent", borderColor: color, borderWidth: 2 } : undefined })),
  });
  const links = rep.signals.filter((s) => s.link && at(s) != null).map((s) => {
    const l = s.link!, series = res.candles.map((x) => (l.price === "high" ? x.spot?.high : x.spot?.low) ?? null);
    return { name: "link", type: "line", showSymbol: false, silent: true, lineStyle: { color: s.direction === "bullish" ? c.up : c.down, type: "dashed", width: 1.5 }, tooltip: { show: false }, data: [[l.a, series[l.a] ?? null], [l.b, series[l.b] ?? null]] };
  });
  return {
    animation: false, grid: { left: 62, right: 16, top: 28, bottom: 30 },
    legend: { top: 0, data: ["NIFTY close", "bullish", "bearish", "neutral"], textStyle: { color: c.paper, fontSize: 12 } },
    tooltip: {
      trigger: "item", confine: true,
      formatter: (p: { data?: { signal?: Signal; all?: Burst[] } }) => {
        const all = p.data?.all ?? (p.data?.signal ? [p.data.signal as Burst] : []);
        return all.map((s) => {
          const run = s.count ?? 1;
          return `<b>${INDICATOR_NAMES[s.id]}</b> (${s.direction}) · ${s.at}${run > 1 ? ` to ${s.lastAt} (${run} candles)` : ""}${s.state === "failed" ? " · failed" : ""}<br/>${s.text}`;
        }).join("<hr/>");
      },
    },
    xAxis: { type: "value", min: 0, max: Math.max(1, labels.length - 1), axisLabel: { color: c.muted, formatter: (v: number) => labels[Math.round(v)] ?? "" }, splitLine: { show: false }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      { name: "NIFTY close", type: "line", showSymbol: false, data: close.map((v, i) => [i, v]), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass }, connectNulls: false },
      mark("bullish", "triangle", c.up, 9), { ...mark("bearish", "triangle", c.down, -9), symbolRotate: 180 }, mark("neutral", "circle", c.muted, 0),
      ...links,
    ],
  };
}
