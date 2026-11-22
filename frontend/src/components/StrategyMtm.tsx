import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { api } from "../lib/api";
import { fmtInt } from "../lib/format";
import { isFuture, legName, type Leg } from "../lib/strategy";
import { buildMtm, type Mtm } from "../lib/strategyMtm";
import type { ChartColors } from "../lib/chartOptions";
import { EChart, useChartColors } from "./EChart";
import { Loading } from "./Loading";

const money = (v: number | null | undefined, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
const tone = (v: number | null | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "");
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
const dayHhmm = (ms: number) => `${new Date(ms + 330 * 60_000).toISOString().slice(5, 10).split("-").reverse().join("/")} ${hhmm(ms)}`;

/**
 * Mark-to-market of the strategy through time: its P&L (booked + open) at every stored one-minute sample since the last leg was entered,
 * futures included. Drawn only from what was stored; a minute without a stored price is a gap. ``liveNow`` is the builder's own live total,
 * shown beside the stored line so the two can be compared (the stored line lags by up to a minute).
 */
export function StrategyMtm({ legs, historyExpiries, lotSize, liveNow }: { legs: Leg[]; historyExpiries: string[]; lotSize: number | null; liveNow: number | null }) {
  const colors = useChartColors();
  const on = useMemo(() => legs.filter((l) => l.enabled !== false), [legs]);
  const optionExps = useMemo(() => [...new Set(on.filter((l) => !isFuture(l)).map((l) => l.expiry))].sort(), [on]);
  const noHistory = optionExps.filter((e) => !historyExpiries.includes(e));
  const since = useMemo(() => {
    const ts = on.map((l) => (l.enteredAt ? Date.parse(l.enteredAt) : NaN)).filter((x) => Number.isFinite(x));
    return ts.length ? new Date(Math.min(...ts) - 60_000).toISOString() : null; // from the first entry; the strategy itself starts at the last one
  }, [on]);
  const strikesOf = (e: string) => [...new Set(on.filter((l) => !isFuture(l) && l.expiry === e).map((l) => l.strike))].sort((a, b) => a - b).join(",");
  const queries = useQueries({
    queries: optionExps.map((e) => ({
      queryKey: ["strategy-mtm", e, strikesOf(e), since],
      enabled: noHistory.length === 0 && !!since && !!lotSize,
      refetchInterval: 30_000, retry: false,
      queryFn: () => api.strikeSeries(e, strikesOf(e), since as string),
    })),
  });
  const hasFut = on.some(isFuture);
  const fut = useQuery({ queryKey: ["strategy-mtm-fut", since], queryFn: () => api.futuresSeries(since as string), enabled: hasFut && !!since, refetchInterval: 30_000, retry: false });
  const pending = since != null && (queries.some((q) => q.isPending) || (hasFut && fut.isPending)); // with no entry time nothing is fetched: the reason is shown at once
  const failed = (queries.find((q) => q.error)?.error ?? fut.error) as Error | null | undefined;
  const byExpiry = useMemo(() => Object.fromEntries(optionExps.map((e, i) => [e, queries[i]?.data])), [optionExps, queries.map((q) => q.dataUpdatedAt).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const mtm: Mtm | null = useMemo(() => (lotSize && !pending ? buildMtm(on, lotSize, byExpiry, fut.data) : null), [on, lotSize, pending, byExpiry, fut.data]);
  const option = useMemo(() => (mtm && mtm.reason == null ? buildOption(mtm, on, colors) : null), [mtm, on, colors]);

  if (on.length === 0 || !lotSize) return <p className="p-3 text-sm text-muted" data-testid="mtm-empty">Add at least one leg to see its mark-to-market.</p>;
  if (noHistory.length > 0) return <p className="p-3 text-sm text-muted" data-testid="mtm-nohistory">The mark-to-market is drawn from stored one-minute prices, which exist only for the expiries the sampler collects. Not stored for {noHistory.join(", ")}.</p>;
  if (failed) return <p className="p-3 text-sm text-muted" data-testid="mtm-error">Could not load the stored prices: {failed.message}</p>;
  if (pending || !mtm) return <Loading label="Loading stored prices…" className="m-3" />;
  if (mtm.reason) return <p className="p-3 text-sm text-muted" data-testid="mtm-reason">{mtm.reason}</p>;
  const stats: [string, string, string][] = [
    ["Now (stored)", money(mtm.now), tone(mtm.now)],
    ["Live now", money(liveNow), tone(liveNow)],
    ["Peak", mtm.peak ? `${money(mtm.peak.pnl)} · ${hhmm(mtm.peak.t)}` : "—", "text-up"],
    ["Trough", mtm.trough ? `${money(mtm.trough.pnl)} · ${hhmm(mtm.trough.t)}` : "—", "text-down"],
    ["Max drawdown", mtm.drawdown ? `${money(-mtm.drawdown.amount)} · ${hhmm(mtm.drawdown.from)}→${hhmm(mtm.drawdown.to)}` : "—", "text-down"],
  ];
  return (
    <div className="p-2" data-testid="mtm">
      <dl className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map(([k, v, c]) => <div key={k} className="rounded-sm border border-rule bg-slate-2 px-2 py-1.5"><dt className="text-[10px] uppercase tracking-wide text-muted">{k}</dt><dd className={`num text-sm ${c}`}>{v}</dd></div>)}
      </dl>
      <div className="h-[340px]"><EChart ariaLabel="Strategy mark-to-market through time" option={option as EChartsCoreOption} /></div>
      <p className="mt-2 text-xs text-muted" data-testid="mtm-note">
        P&amp;L of the whole strategy (booked + open, before costs) at each stored one-minute sample, from {dayHhmm(mtm.from as number)} IST when the last leg was entered. An exited leg stays at what it booked.
        {mtm.missing > 0 ? ` ${mtm.missing} minute${mtm.missing === 1 ? "" : "s"} had no stored price for some leg and are left as gaps.` : ""}
        {on.some(isFuture) ? " The future is priced from the stored future series of its contract." : ""} Stored samples lag the live value by up to a minute.
      </p>
    </div>
  );
}

function buildOption(m: Mtm, legs: Leg[], c: ChartColors): EChartsCoreOption {
  const data = m.t.map((t, i) => [t, m.pnl[i]]);
  const events: { xAxis: number; name: string; lineStyle: { color: string; type: string; width: number }; label: { formatter: string; color: string; fontSize: number; position: string } }[] = [];
  for (const l of legs) {
    if (l.exitedAt && l.exitPrice != null) {
      const t = Date.parse(l.exitedAt);
      if (t >= (m.from ?? 0) && t <= m.t[m.t.length - 1]!) events.push({ xAxis: t, name: legName(l), lineStyle: { color: c.muted, type: "dotted", width: 1 }, label: { formatter: `${legName(l)} out`, color: c.muted, fontSize: 10, position: "insideEndTop" } });
    }
  }
  return {
    animation: false, grid: { left: 64, right: 24, top: 24, bottom: 36 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: { value: [number, number | null] }[]) => { const v = p[0]?.value; return v ? `${dayHhmm(v[0])} IST<br/>MTM ${money(v[1])}` : ""; } },
    xAxis: { type: "time", axisLabel: { color: c.muted, formatter: (v: number) => hhmm(v) }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: (v: number) => money(v, false) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [{
      name: "MTM", type: "line", showSymbol: false, connectNulls: false, data,
      lineStyle: { color: c.brass, width: 2 }, areaStyle: { color: c.brass, opacity: 0.08 },
      markLine: { symbol: "none", silent: true, data: [{ yAxis: 0, name: "Break-even", lineStyle: { color: c.muted, type: "dashed", width: 1 }, label: { formatter: "₹0", color: c.muted, fontSize: 10 } }, ...events] },
    }],
  };
}
