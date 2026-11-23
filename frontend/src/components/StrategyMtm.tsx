import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { api } from "../lib/api";
import { fmtInt } from "../lib/format";
import { isFuture, legName, type Leg } from "../lib/strategy";
import { appendTick, buildMtm, joinLive, mtmStats, splitAtZero, type Mtm } from "../lib/strategyMtm";
import { liveMtmKey, mtmSince } from "../lib/closedMtm";
import type { ChartColors } from "../lib/chartOptions";
import { EChart, useChartColors } from "./EChart";
import { Loading } from "./Loading";

export const money = (v: number | null | undefined, signed = true) => (v == null ? "—" : `${v < 0 ? "−" : v > 0 && signed ? "+" : ""}₹${fmtInt(Math.round(Math.abs(v)))}`);
export const tone = (v: number | null | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "");
export const hhmmss = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 19);
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
export const dayHhmm = (ms: number) => `${new Date(ms + 330 * 60_000).toISOString().slice(5, 10).split("-").reverse().join("/")} ${hhmm(ms)}`;

/**
 * Mark-to-market of the strategy through time: its P&L (booked + open, futures included) live, tick by tick. The line starts from the stored one-minute
 * samples (what happened before this page was open) and continues with every change of the live value seen here. The tiles read the same line:
 * the live value, the highest, the lowest, and the largest fall from a high. Kept for the day in this browser, so leaving the page does not lose it.
 */
export function StrategyMtm({ legs, historyExpiries, lotSize, liveNow }: { legs: Leg[]; historyExpiries: string[]; lotSize: number | null; liveNow: number | null }) {
  const colors = useChartColors();
  const on = useMemo(() => legs.filter((l) => l.enabled !== false), [legs]);
  const optionExps = useMemo(() => [...new Set(on.filter((l) => !isFuture(l)).map((l) => l.expiry))].sort(), [on]);
  const noHistory = optionExps.filter((e) => !historyExpiries.includes(e));
  const since = useMemo(() => mtmSince(on), [on]); // from the first entry
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
  const liveKey = liveMtmKey(on); // by first entry and leg ids, so exits do not change it and the closing page finds the same ticks
  const readLive = (): { t: number; v: number }[] => { try { const v = JSON.parse(sessionStorage.getItem(liveKey) ?? "[]") as unknown; return Array.isArray(v) ? (v as { t: number; v: number }[]) : []; } catch { return []; } };
  const [live, setLive] = useState<{ t: number; v: number }[]>(readLive);
  useEffect(() => { setLive(readLive()); }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (liveNow == null || !Number.isFinite(liveNow)) return;
    setLive((s) => { const n = appendTick(s, Date.now(), liveNow); if (n !== s) { try { sessionStorage.setItem(liveKey, JSON.stringify(n)); } catch { /* memory only */ } } return n; });
  }, [liveNow, liveKey]);
  // stored history before the first live tick, then the live ticks. A brand-new position has no stored sample yet: the live ticks alone are drawn.
  const base: Mtm | null = mtm && (mtm.reason == null || (mtm.from != null && live.length > 0)) ? mtm : null;
  const pts = useMemo(() => joinLive(base ? base.t.map((t, i) => ({ t, pnl: base.pnl[i] ?? null })) : [], live), [base, live]);
  const stats = useMemo(() => mtmStats(pts), [pts]);
  const shown: Mtm | null = useMemo(() => (base && pts.length > 0 ? { ...base, t: pts.map((p) => p.t), pnl: pts.map((p) => p.v), now: stats.now, peak: stats.high ? { pnl: stats.high.v, t: stats.high.t } : null, trough: stats.low ? { pnl: stats.low.v, t: stats.low.t } : null, drawdown: stats.drawdown, reason: null } : null), [base, pts, stats]);
  const option = useMemo(() => (shown ? buildOption(shown, on, colors) : null), [shown, on, colors]);

  if (on.length === 0 || !lotSize) return <p className="p-3 text-sm text-muted" data-testid="mtm-empty">Add at least one leg to see its mark-to-market.</p>;
  if (noHistory.length > 0) return <p className="p-3 text-sm text-muted" data-testid="mtm-nohistory">The mark-to-market starts from stored one-minute prices, which exist only for the expiries the sampler collects. Not stored for {noHistory.join(", ")}.</p>;
  if (failed) return <p className="p-3 text-sm text-muted" data-testid="mtm-error">Could not load the stored prices: {failed.message}</p>;
  if (pending || !mtm) return <Loading label="Loading stored prices…" className="m-3" />;
  if (!shown) return <p className="p-3 text-sm text-muted" data-testid="mtm-reason">{mtm.reason}</p>;
  const tiles: [string, string, string][] = [
    ["Live MTM", money(stats.now), tone(stats.now)],
    ["Max high", stats.high ? `${money(stats.high.v)} · ${hhmmss(stats.high.t)}` : "—", "text-up"],
    ["Max low", stats.low ? `${money(stats.low.v)} · ${hhmmss(stats.low.t)}` : "—", "text-down"],
    ["Drawdown", stats.drawdown ? `${money(-stats.drawdown.amount)} · ${hhmmss(stats.drawdown.from)}→${hhmmss(stats.drawdown.to)}` : "—", "text-down"],
  ];
  return (
    <div className="p-2" data-testid="mtm">
      <dl className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([k, v, c]) => <div key={k} className="rounded-sm border border-rule bg-slate-2 px-2 py-1.5"><dt className="text-[10px] uppercase tracking-wide text-muted">{k}</dt><dd className={`num text-sm ${c}`}>{v}</dd></div>)}
      </dl>
      <div className="h-[340px]"><EChart ariaLabel="Strategy mark-to-market through time" option={option as EChartsCoreOption} /></div>
      <p className="mt-2 text-xs text-muted" data-testid="mtm-note">
        P&amp;L of the whole strategy (booked + open, before costs), live: every change of the value seen on this page is a point, after the stored one-minute samples from {dayHhmm(shown.from as number)} IST when the first leg was entered; a leg added later counts from its own entry. The high, the low and the drawdown are read from this same line. An exited leg stays at what it booked.
        {mtm.missing > 0 ? ` ${mtm.missing} stored minute${mtm.missing === 1 ? "" : "s"} had no price for some leg and are left as gaps.` : ""}
        {on.some(isFuture) ? " The future is priced from its own live quote." : ""} The stored part can differ slightly from the live part where the last traded price moved between samples.
      </p>
    </div>
  );
}

export function buildOption(m: Mtm, legs: Leg[], c: ChartColors): EChartsCoreOption {
  const z = splitAtZero(m.t, m.pnl);
  const hidden = { lineStyle: { width: 0, opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } };
  const events: { xAxis: number; name: string; lineStyle: { color: string; type: string; width: number }; label: { formatter: string; color: string; fontSize: number; position: string } }[] = [];
  for (const l of legs) {
    if (l.exitedAt && l.exitPrice != null) {
      const t = Date.parse(l.exitedAt);
      if (t >= (m.from ?? 0) && t <= m.t[m.t.length - 1]!) events.push({ xAxis: t, name: legName(l), lineStyle: { color: c.muted, type: "dotted", width: 1 }, label: { formatter: `${legName(l)} out`, color: c.muted, fontSize: 10, position: "insideEndTop" } });
    }
  }
  return {
    animation: false, grid: { left: 64, right: 24, top: 24, bottom: 36 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: { seriesName?: string; value: [number, number | null] }[]) => { const v = p.find((x) => x.seriesName === "MTM")?.value; return v ? `${dayHhmm(v[0])} IST<br/>MTM <b style="color:${(v[1] ?? 0) >= 0 ? c.up : c.down}">${money(v[1])}</b>` : ""; } },
    xAxis: { type: "time", axisLabel: { color: c.muted, formatter: (v: number) => (m.t.length > 1 && m.t[m.t.length - 1]! - m.t[0]! < 1_800_000 ? hhmmss(v) : hhmm(v)) }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: false } },
    yAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => money(v, false) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    series: [
      // green area above zero, red area below it, each meeting the other exactly where the line crosses zero
      { name: "above zero", type: "line", data: z.pos, ...hidden, areaStyle: { color: c.up, opacity: 0.22 }, z: 1 },
      { name: "below zero", type: "line", data: z.neg, ...hidden, areaStyle: { color: c.down, opacity: 0.22 }, z: 1 },
      { name: "line above zero", type: "line", data: z.linePos, showSymbol: false, silent: true, connectNulls: false, lineStyle: { color: c.up, width: 2 }, itemStyle: { color: c.up }, tooltip: { show: false }, z: 3 },
      { name: "line below zero", type: "line", data: z.lineNeg, showSymbol: false, silent: true, connectNulls: false, lineStyle: { color: c.down, width: 2 }, itemStyle: { color: c.down }, tooltip: { show: false }, z: 3 },
      // the full series carries the tooltip, the zero line and the exit marks
      {
        name: "MTM", type: "line", data: z.full, ...hidden, silent: false, tooltip: { show: true }, z: 4,
        markLine: { symbol: "none", silent: true, data: [{ yAxis: 0, name: "Break-even", lineStyle: { color: c.muted, type: "dashed", width: 1 }, label: { formatter: "₹0", color: c.muted, fontSize: 11 } }, ...events] },
      },
    ],
  };
}
