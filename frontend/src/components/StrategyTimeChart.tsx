import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { api } from "../lib/api";
import { fmtInt } from "../lib/format";
import type { ChartColors } from "../lib/chartOptions";
import type { Action, OptionType, StrategyRules } from "../lib/strategy";
import {
  alignFuture, bands, buildTimeline, cumMean, cumWeighted, decompose, ema, regress, sma, timelineStats, type Timeline, type TimelineLeg,
} from "../lib/strategyTimeline";
import { EChart, useChartColors } from "./EChart";

const money = (v: number | null | undefined, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const pts = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const tone = (v: number | null | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "");

interface ChartLeg { strike: number; type: OptionType; action: Action; lots: number; premium: number | null; expiry: string }

/** The built strategy as one price through the day (and its P&L), against NIFTY spot and future, with averages, bands and a split of what moved it. */
export function StrategyTimeChart({ legs, expiry, lotSize, modelDelta, rules }: { legs: ChartLeg[]; expiry: string | null; lotSize: number | null; modelDelta: number | null; rules: StrategyRules }) {
  const colors = useChartColors();
  const [days, setDays] = useState<1 | 3>(1);
  const [mode, setMode] = useState<"premium" | "pnl">("premium");
  const use = useMemo(() => legs.filter((l) => l.expiry === expiry), [legs, expiry]);
  const other = legs.length - use.length;
  const strikes = useMemo(() => [...new Set(use.map((l) => l.strike))].sort((a, b) => a - b).join(","), [use]);
  const ss = useQuery({
    queryKey: ["strategy-timeline", expiry, strikes, days],
    enabled: !!expiry && use.length > 0 && !!lotSize,
    refetchInterval: 30_000, retry: false,
    queryFn: async () => {
      const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const sinceToday = new Date(`${day}T00:00:00+05:30`).toISOString();
      const wide = new Date(Date.now() - 8 * 86_400_000).toISOString();
      if (days === 1) {
        const t = await api.strikeSeries(expiry!, strikes, sinceToday);
        if (t.times.length >= 5) return t;
      }
      return api.strikeSeries(expiry!, strikes, wide); // weekend or before the open: the newest stored sessions
    },
  });
  const fut = useQuery({ queryKey: ["strategy-timeline-fut", days], queryFn: () => api.futuresSeries(new Date(Date.now() - 8 * 86_400_000).toISOString()), refetchInterval: 30_000, retry: false, enabled: use.length > 0 });

  const model = useMemo(() => {
    if (!ss.data || !lotSize) return null;
    const tl = buildTimeline(use as TimelineLeg[], ss.data, lotSize, { days });
    if (tl.samples < 2) return { tl, empty: true as const };
    const { future, volume } = alignFuture(tl, fut.data);
    const main = mode === "pnl" ? tl.pnl : tl.display;
    const reg = regress(tl.spot, tl.pnl, tl);
    const dec = reg ? decompose(tl.pnl, tl.spot, reg.beta) : null;
    return {
      tl, empty: false as const, main, future, reg, dec,
      futVwap: cumWeighted(future, volume, tl),
      stratVwap: mode === "pnl" ? tl.vwapPnl : tl.vwap,
      twap: cumMean(main, tl),
      sma14: sma(main, 14, tl), ema50: ema(main, 50, tl), bb: bands(main, 20, 2, tl),
      stats: timelineStats(tl),
    };
  }, [ss.data, fut.data, use, lotSize, days, mode]);

  if (!expiry || use.length === 0 || !lotSize) {
    return <p className="p-3 text-sm text-muted" data-testid="stl-empty">Add at least one leg of the selected expiry to see the strategy as a price through the day.</p>;
  }
  if (ss.isPending) return <p className="p-3 text-sm text-muted">Loading stored samples…</p>;
  if (ss.error) return <p className="p-3 text-sm text-muted">Could not load the stored strike prices: {String((ss.error as Error).message)}</p>;
  if (!model || model.empty) return <p className="p-3 text-sm text-muted" data-testid="stl-few">Not enough stored samples for these strikes yet ({model?.tl.samples ?? 0}). The sampler stores one a minute during market hours.</p>;

  const { tl, stats, reg } = model;
  const unit = mode === "pnl" ? "₹" : "points";
  const entry = (() => {
    if (mode === "pnl") return 0;
    if (use.some((l) => l.premium == null)) return null;
    const v = use.reduce((s, l) => s + (l.action === "BUY" ? 1 : -1) * l.lots * (l.premium as number), 0);
    return tl.isCredit ? -v : v;
  })();
  const main = buildOption(tl, model, mode, entry, rules, colors);
  const dev = buildSplit(tl, model.dec, colors);
  const lines: string[] = [];
  if (stats.now != null && stats.open != null) {
    lines.push(mode === "pnl"
      ? `P&L now ${money(stats.now)}, ${stats.now - stats.open >= 0 ? "up" : "down"} ${money(Math.abs(stats.now - stats.open), false)} since the first sample; range ${money(stats.low)} to ${money(stats.high)}.`
      : `${tl.isCredit ? "Cost to close" : "Position value"} ${pts(stats.now)} points, ${pts(stats.change)} (${stats.changePct == null ? "—" : `${stats.changePct >= 0 ? "+" : "−"}${Math.abs(stats.changePct).toFixed(1)}%`}) from the first sample; range ${pts(stats.low)} to ${pts(stats.high)}.`);
  }
  {
    const i = tl.display.map((v, k) => (v != null && !tl.spacer[k] ? k : -1)).filter((k) => k >= 0).pop();
    const vw = i == null ? null : (mode === "pnl" ? tl.vwapPnl : tl.vwap)[i] ?? null;
    const nowV = i == null ? null : (mode === "pnl" ? tl.pnl : tl.display)[i] ?? null;
    if (vw != null && nowV != null) lines.push(mode === "pnl"
      ? `P&L ${money(nowV)} against ${money(vw)} had every leg been traded at its VWAP: ${nowV >= vw ? "ahead of" : "behind"} the volume-weighted entry level by ${money(Math.abs(nowV - vw), false)}.`
      : `${tl.isCredit ? "Cost to close" : "Position value"} ${pts(nowV)} is ${pts(Math.abs(nowV - vw))} ${nowV >= vw ? "above" : "below"} the strategy VWAP ${pts(vw)}${tl.isCredit ? (nowV >= vw ? ": a seller from the VWAP level is behind" : ": a seller from the VWAP level is ahead") : ""}.`);
    else if (i != null) lines.push("Strategy VWAP is not available: at least one leg has no stored traded volume yet.");
  }
  if (stats.zScore != null) lines.push(`Now ${Math.abs(stats.zScore).toFixed(1)} standard deviations ${stats.zScore >= 0 ? "above" : "below"} its average for the day, at the ${Math.round(stats.percentile ?? 0)}th percentile of the day's values.`);
  if (reg) {
    lines.push(`Empirical delta ${money(reg.beta)} per NIFTY point (R² ${reg.r2.toFixed(2)}, ${reg.n} ${reg.lag}-sample changes)${modelDelta != null ? ` against the model's ${money(modelDelta)} per point` : ""}.`);
  }
  if (model.dec) {
    const e = [...model.dec.explained].reverse().find((v) => v != null) ?? null;
    const r = [...model.dec.rest].reverse().find((v) => v != null) ?? null;
    if (e != null && r != null) lines.push(`Of the P&L change since the first sample, about ${money(e)} is spot-driven and ${money(r)} is everything else (time decay, volatility, curvature).`);
  }

  return (
    <div className="space-y-3 p-2" data-testid="strategy-time-chart">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div role="group" aria-label="Show" className="flex gap-0.5">
          {([["premium", tl.isCredit ? "Cost to close" : "Position value"], ["pnl", "P&L ₹"]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)} className={`min-h-8 rounded-sm border px-2.5 ${mode === k ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{l}</button>
          ))}
        </div>
        <div role="group" aria-label="Range" className="flex gap-0.5">
          {([[1, "Today"], [3, "Last 3 sessions"]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={days === k} onClick={() => setDays(k)} className={`min-h-8 rounded-sm border px-2.5 ${days === k ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{l}</button>
          ))}
        </div>
        <span className="text-muted">{tl.samples} samples · {tl.missing > 0 ? `${tl.missing} without every leg price (left blank) · ` : ""}{unit}. Click a legend name to show or hide a line.</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8" aria-label="Strategy summary">
        {([
          ["Now", mode === "pnl" ? money(stats.pnlNow) : pts(stats.now), mode === "pnl" ? tone(stats.pnlNow) : "text-paper"],
          ["Day high", mode === "pnl" ? money(stats.pnlHigh) : pts(stats.high), "text-paper"],
          ["Day low", mode === "pnl" ? money(stats.pnlLow) : pts(stats.low), "text-paper"],
          ["From open", mode === "pnl" ? money(stats.pnlNow != null && stats.pnlHigh != null ? stats.pnlNow - (tl.pnl.find((v) => v != null) ?? 0) : null) : `${pts(stats.change)}${stats.changePct == null ? "" : ` (${stats.changePct >= 0 ? "+" : "−"}${Math.abs(stats.changePct).toFixed(1)}%)`}`, mode === "pnl" ? "text-paper" : tone(stats.change)],
          ["Day average", mode === "pnl" ? "—" : pts(stats.mean), "text-paper"],
          ["Z-score", stats.zScore == null ? "—" : stats.zScore.toFixed(2), "text-paper"],
          ["Max drawdown", money(stats.maxDrawdown), tone(stats.maxDrawdown)],
          ["NIFTY since open", stats.spotMove == null ? "—" : `${stats.spotMove >= 0 ? "+" : "−"}${Math.abs(Math.round(stats.spotMove))} pts`, tone(stats.spotMove)],
        ] as const).map(([k, v, c]) => (
          <div key={k} className="rounded-sm bg-slate-2 px-2 py-1.5"><div className="text-[11px] text-muted">{k}</div><div className={`num text-sm font-semibold ${c}`}>{v}</div></div>
        ))}
      </div>

      <div className="rounded-xl border border-rule bg-ink/40 p-2" data-testid="stl-main">
        <div className="h-[380px]"><EChart group="strategy-timeline" ariaLabel={`Strategy ${mode === "pnl" ? "P&L" : "price"} against NIFTY spot and future`} option={main} /></div>
      </div>
      <div className="rounded-xl border border-rule bg-ink/40 p-2" data-testid="stl-split">
        <div className="h-[170px]"><EChart group="strategy-timeline" ariaLabel="Spot-driven and other P&L since the first sample" option={dev} /></div>
      </div>

      <ul className="space-y-1 text-sm text-paper" aria-label="Reading">
        {lines.map((t) => <li key={t} className="flex gap-2 leading-relaxed"><span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brass" />{t}</li>)}
      </ul>
      <p className="text-[11px] leading-relaxed text-muted" data-testid="stl-note">
        Built from the stored one-minute samples of the strikes in your legs ({use.map((l) => `${l.action === "BUY" ? "+" : "−"}${l.lots}×${fmtInt(l.strike)}${l.type}`).join(" ")}), last traded prices, not bid or ask; a minute without a price is left blank, never filled.
        {other > 0 ? ` ${other} leg(s) of another expiry are not charted.` : ""} Strategy VWAP combines each leg&apos;s own volume-weighted average price (stored traded volume of that contract, priced at the last price of each interval, restarting every day) the same way as the strategy value: what building the structure at every leg&apos;s VWAP would have cost; it starts once every leg has traded. Future VWAP is the volume-weighted price of the NIFTY current-month future.
        The spot-driven split is a regression on this range (change over 5 samples against NIFTY points), an estimate of delta, not a Greek; the rest is time decay, volatility, curvature and noise. Entry level is your entry premium{mode === "pnl" ? "; the strategy stop and target from the rules are drawn when set" : ""}. Nothing here is a forecast or an order.
        {fut.data == null && fut.isError ? " The futures series could not be loaded, so the future and VWAP lines are missing." : ""}
      </p>
    </div>
  );
}

interface Model {
  main: (number | null)[]; future: (number | null)[]; futVwap: (number | null)[]; stratVwap: (number | null)[]; twap: (number | null)[];
  sma14: (number | null)[]; ema50: (number | null)[]; bb: { mid: (number | null)[]; up: (number | null)[]; low: (number | null)[] };
}

function buildOption(tl: Timeline, m: Model, mode: "premium" | "pnl", entry: number | null, rules: StrategyRules, c: ChartColors): EChartsCoreOption {
  const name = mode === "pnl" ? "Strategy P&L" : tl.isCredit ? "Cost to close" : "Position value";
  const ax = { color: c.muted, fontSize: 11 };
  const line = (n: string, data: (number | null)[], color: string, extra: object = {}, y = 0) => ({ name: n, type: "line", yAxisIndex: y, data, showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, color }, itemStyle: { color }, ...extra });
  const marks: { yAxis: number; name: string; lineStyle: object; label: object }[] = [];
  if (entry != null) marks.push({ yAxis: entry, name: mode === "pnl" ? "Break-even" : "Entry", lineStyle: { color: c.muted, type: "dashed", width: 1 }, label: { formatter: mode === "pnl" ? "Break-even" : "Entry", color: c.muted, fontSize: 10 } });
  if (mode === "pnl" && rules.sl != null && rules.sl > 0) marks.push({ yAxis: -rules.sl, name: "Strategy stop", lineStyle: { color: c.down, type: "dotted", width: 1 }, label: { formatter: "Stop", color: c.down, fontSize: 10 } });
  if (mode === "pnl" && rules.target != null && rules.target > 0) marks.push({ yAxis: rules.target, name: "Strategy target", lineStyle: { color: c.up, type: "dotted", width: 1 }, label: { formatter: "Target", color: c.up, fontSize: 10 } });
  const off = { sma14: false, ema50: false, bands: false, twap: false } as const;
  return {
    animation: false, grid: { left: 62, right: 62, top: 62, bottom: 28 },
    legend: { top: 0, left: 8, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 16, itemHeight: 8, selected: { "NIFTY spot": true, "NIFTY future": false, "Future VWAP": true, "Strategy VWAP": true, "Time average": off.twap, "SMA 14": off.sma14, "EMA 50": off.ema50, "Bollinger 20, 2σ": off.bands } },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "cross" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })) },
    xAxis: { type: "category", data: tl.label, boundaryGap: false, axisLabel: { ...ax, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: [
      { type: "value", scale: true, name: mode === "pnl" ? "₹" : "points", nameTextStyle: ax, axisLabel: { ...ax, formatter: (v: number) => v.toLocaleString("en-IN") }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      { type: "value", scale: true, position: "right", name: "NIFTY", nameTextStyle: ax, axisLabel: { ...ax, formatter: (v: number) => v.toLocaleString("en-IN") }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      line(name, m.main, c.info, { lineStyle: { width: 2.4, color: c.info }, z: 5, markLine: marks.length ? { symbol: "none", silent: true, data: marks } : undefined }),
      line("NIFTY spot", tl.spot, c.muted, { lineStyle: { width: 1.2, color: c.muted, type: "dotted" } }, 1),
      line("NIFTY future", m.future, c.brass, { lineStyle: { width: 1.2, color: c.brass, type: "dotted" } }, 1),
      line("Future VWAP", m.futVwap, c.brass, { lineStyle: { width: 1.4, color: c.brass, type: "dashed" } }, 1),
      line("Strategy VWAP", m.stratVwap, c.up, { lineStyle: { width: 1.8, color: c.up, type: "dashed" } }),
      line("Time average", m.twap, c.up, { lineStyle: { width: 1.2, color: c.up, type: "dotted" } }),
      line("SMA 14", m.sma14, c.paper, { lineStyle: { width: 1.2, color: c.paper } }),
      line("EMA 50", m.ema50, c.down, { lineStyle: { width: 1.2, color: c.down } }),
      line("Bollinger 20, 2σ", m.bb.up, c.rule, { lineStyle: { width: 1, color: c.muted, opacity: 0.7 } }),
      { name: "Bollinger 20, 2σ", type: "line", yAxisIndex: 0, data: m.bb.low, showSymbol: false, lineStyle: { width: 1, color: c.muted, opacity: 0.7 }, itemStyle: { color: c.muted } },
    ],
  };
}

function buildSplit(tl: Timeline, dec: { explained: (number | null)[]; rest: (number | null)[] } | null, c: ChartColors): EChartsCoreOption {
  const ax = { color: c.muted, fontSize: 11 };
  const none = !dec;
  return {
    animation: false, grid: { left: 62, right: 62, top: 30, bottom: 24 },
    title: { text: none ? "Spot-driven vs other P&L: needs about 25 samples with every price" : "P&L change since the first sample: spot-driven (estimated) and everything else", left: 62, top: 0, textStyle: { color: c.muted, fontSize: 11, fontWeight: "normal" } },
    legend: { top: 0, right: 8, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (v == null ? "—" : `₹${Math.round(Number(v)).toLocaleString("en-IN")}`) },
    xAxis: { type: "category", data: tl.label, boundaryGap: false, axisLabel: { ...ax, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { ...ax, formatter: (v: number) => v.toLocaleString("en-IN") }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    dataZoom: [{ type: "inside", filterMode: "none" }],
    series: [
      { name: "Spot-driven", type: "line", data: dec?.explained ?? [], showSymbol: false, lineStyle: { width: 1.8, color: c.info }, itemStyle: { color: c.info } },
      { name: "Decay, volatility and other", type: "line", data: dec?.rest ?? [], showSymbol: false, lineStyle: { width: 1.8, color: c.brass }, itemStyle: { color: c.brass }, markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, width: 1 }, data: [{ yAxis: 0 }] } },
    ],
  };
}

