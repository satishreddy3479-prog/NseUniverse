import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useExpiries } from "../lib/hooks";
import { fmtTimeIST, MISSING } from "../lib/format";
import type { IvSeries } from "../lib/types";
import { EChart, useChartColors } from "./EChart";

const MAX_EXPIRIES = 5;
const TFS = [1, 3, 5, 15];
const one = (v: number | null | undefined) => (v == null ? MISSING : `${v.toFixed(2)}%`);
const pts = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} pts`);
const btn = (on: boolean) => `min-h-9 rounded-sm border px-3 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;

/** At-the-money implied volatility through a stored session for up to five expiries, with the synthetic future, or the term structure at the last snapshot. */
export function IvIntradayBody({ expiry }: { expiry: string | null }) {
  const c = useChartColors();
  const exp = useExpiries().data;
  const [picked, setPicked] = useState<string[]>([]);
  const [tf, setTf] = useState(1);
  const [session, setSession] = useState("");
  const [view, setView] = useState<"intraday" | "term">("intraday");
  const sessions = useQuery({ queryKey: ["ivSessions"], queryFn: () => api.intradayIvSessions(), retry: false, staleTime: 300_000 }).data?.sessions ?? [];
  const available = exp?.available?.length ? exp.available : expiry ? [expiry] : [];
  const chosen = picked.length ? picked.filter((e) => available.includes(e) || e === expiry) : expiry ? [expiry] : [];
  const results = useQueries({
    queries: chosen.map((e) => ({
      queryKey: ["ivSeries", e, session, tf], queryFn: () => api.intradayIvSeries(e, { session: session || undefined, tf, maxPoints: 400 }), refetchInterval: 60_000, retry: false,
    })),
  });
  const toggle = (e: string) => setPicked((cur) => {
    const base = cur.length ? cur : chosen;
    return base.includes(e) ? (base.length > 1 ? base.filter((x) => x !== e) : base) : base.length < MAX_EXPIRIES ? [...base, e] : base;
  });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;

  const series = results.map((r, i) => ({ expiry: chosen[i]!, s: r.data as IvSeries | undefined, error: r.isError, loading: r.isLoading }));
  const loaded = series.filter((x) => x.s && x.s.points.length > 0);
  const primary = loaded[0]?.s;
  const palette = [c.brass, c.info, c.up, c.down, c.muted];
  const label = (iso: string) => fmtTimeIST(iso);
  const times = [...new Set(loaded.flatMap((x) => x.s!.points.map((p) => label(p.at))))].sort();
  const colorOf = (e: string) => palette[chosen.indexOf(e) % palette.length]!;

  const intraday = loaded.length === 0 ? null : {
    grid: { left: 46, right: 56, top: 40, bottom: 28 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: times, axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
      { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } },
    ],
    series: [
      ...loaded.map((x) => {
        const by = new Map(x.s!.points.map((p) => [label(p.at), p.atm_iv]));
        return { name: `IV ${x.expiry}`, type: "line", showSymbol: x.s!.points.length < 40, connectNulls: false, data: times.map((t) => by.get(t) ?? null), lineStyle: { color: colorOf(x.expiry), width: 2 }, itemStyle: { color: colorOf(x.expiry) } };
      }),
      (() => {
        const by = new Map(primary!.points.map((p) => [label(p.at), p.forward ?? null]));
        return { name: "Synthetic future", type: "line", yAxisIndex: 1, showSymbol: false, connectNulls: false, data: times.map((t) => by.get(t) ?? null), lineStyle: { color: c.muted, width: 1, opacity: 0.8 }, itemStyle: { color: c.muted } };
      })(),
    ],
  };

  // term structure: the last valid snapshot of each chosen expiry
  const termRows = loaded.map((x) => {
    const last = [...x.s!.points].reverse().find((p) => p.atm_iv != null);
    return { expiry: x.expiry, days: last?.days ?? null, iv: last?.atm_iv ?? null, at: last?.at ?? null };
  }).filter((r) => r.iv != null).sort((a, b) => (a.days ?? 0) - (b.days ?? 0));
  const termOpt = {
    grid: { left: 46, right: 14, top: 24, bottom: 28 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) },
    xAxis: { type: "category", data: termRows.map((r) => `${r.expiry.slice(5)} (${r.days == null ? "?" : r.days.toFixed(1)}d)`), axisLabel: { color: c.muted }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
    series: [{ name: "ATM IV", type: "line", symbolSize: 8, data: termRows.map((r) => r.iv), lineStyle: { color: c.brass, width: 2 }, itemStyle: { color: c.brass } }],
  };

  const valid = primary?.points.filter((p) => p.atm_iv != null) ?? [];
  const first = valid[0]?.atm_iv ?? null;
  const last = valid[valid.length - 1]?.atm_iv ?? null;
  const stale = primary != null && (primary.age_seconds ?? 0) > 300 && !!primary.is_today;
  const empty = loaded.length === 0 && series.every((x) => !x.loading);
  const firstProblem = series.find((x) => x.s && x.s.points.length === 0)?.s?.status;

  return (
    <div className="flex flex-col gap-3" data-testid="ivintraday-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <div className="flex items-center gap-1" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "intraday"} className={btn(view === "intraday")} onClick={() => setView("intraday")}>Intraday</button>
            <button type="button" aria-pressed={view === "term"} className={btn(view === "term")} onClick={() => setView("term")}>Term structure</button>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Timeframe"><span className="mr-1">Candle</span>
            {TFS.map((m) => <button key={m} type="button" aria-pressed={tf === m} className={btn(tf === m)} onClick={() => setTf(m)}>{m}m</button>)}
          </div>
          <label className="flex items-center gap-1">Session
            <select aria-label="Session" value={session} onChange={(e) => setSession(e.target.value)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-xs text-paper">
              <option value="">Latest</option>
              {[...sessions].reverse().map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted" role="group" aria-label="Expiries (up to 5)"><span className="mr-1">Expiries</span>
          {available.slice(0, 12).map((e) => <button key={e} type="button" aria-pressed={chosen.includes(e)} className={btn(chosen.includes(e))} onClick={() => toggle(e)}>{e.slice(5)}</button>)}
        </div>
        {primary && (
          <div className="mt-2 text-xs text-muted">Expiry {primary.expiry} · session {primary.session}{primary.is_today ? "" : " (not today: a stored session)"} · {primary.samples_in_session} {tf}-minute candle{primary.samples_in_session === 1 ? "" : "s"}{primary.thinned_every && primary.thinned_every > 1 ? `, every ${primary.thinned_every}th shown` : ""} · newest {primary.latest_at ? fmtTimeIST(primary.latest_at) : MISSING} IST</div>
        )}
        {stale && <p className="mt-1 text-xs text-warn" data-testid="ivintraday-stale">The newest snapshot is {Math.round((primary!.age_seconds ?? 0) / 60)} minutes old: the sampler may have stopped.</p>}
        {primary && (
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4" data-testid="ivintraday-stats">
            <div><div className="text-[11px] text-muted">Latest ATM IV</div><div className="num text-lg font-semibold text-paper">{one(last)}</div></div>
            <div><div className="text-[11px] text-muted">Change since first</div><div className="num text-paper">{first == null || last == null ? MISSING : pts(last - first)}</div></div>
            <div><div className="text-[11px] text-muted">Session high</div><div className="num text-paper">{one(primary.high)}</div></div>
            <div><div className="text-[11px] text-muted">Session low</div><div className="num text-paper">{one(primary.low)}</div></div>
          </div>
        )}
        {primary && valid.length < primary.points.length && <p className="mt-1 text-[11px] text-muted">{primary.points.length - valid.length} snapshot(s) had no computable IV (shown as gaps, never filled).</p>}
        {series.some((x) => x.error) && <p role="alert" className="mt-1 text-xs text-down">An expiry&apos;s series could not be loaded.</p>}
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        {series.some((x) => x.loading) && loaded.length === 0 ? <div className="h-40 animate-pulse" aria-label="Loading" />
          : empty ? <p className="text-sm text-muted" data-testid="ivintraday-empty">{firstProblem ?? "No stored option-chain sample for these expiries"}.</p>
          : view === "intraday" ? (
            <>
              <h2 className="mb-1 text-sm font-semibold text-paper">At-the-money implied volatility through the session</h2>
              <div style={{ height: 340 }}><EChart option={intraday!} ariaLabel="At-the-money implied volatility through the session" /></div>
              <p className="mt-2 text-[11px] text-muted">{primary?.model}; assumed rate {primary?.rate_assumed == null ? MISSING : `${(primary.rate_assumed * 100).toFixed(2)}%`}. ATM IV is solved from the ATM call and put against the synthetic future (put-call parity), one value per {tf}-minute candle. {loaded.length < chosen.length ? `${chosen.length - loaded.length} chosen expir${chosen.length - loaded.length === 1 ? "y has" : "ies have"} nothing stored for this session. ` : ""}A change in IV is context, not a prediction.</p>
            </>
          ) : termRows.length >= 2 ? (
            <>
              <h2 className="mb-1 text-sm font-semibold text-paper">Term structure at the last snapshot</h2>
              <div style={{ height: 320 }} data-testid="ivintraday-term"><EChart option={termOpt} ariaLabel="At-the-money implied volatility by expiry" /></div>
              <p className="mt-2 text-[11px] text-muted">Last computable ATM IV of each chosen expiry in this session ({termRows.map((r) => `${r.expiry.slice(5)} at ${r.at ? fmtTimeIST(r.at) : MISSING}`).join(", ")} IST); expiries are not always sampled at the same minute. Near expiries carry event and expiry-day effects.</p>
            </>
          ) : <p className="text-sm text-muted" data-testid="ivintraday-term-empty">Choose at least two expiries with stored data for a term structure.</p>}
      </div>
    </div>
  );
}
