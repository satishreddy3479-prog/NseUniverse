import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import type { IvMomentum as Mom, IvMomentumChange } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { MethodologyPanel } from "./MethodologyPanel";

const BUCKETS = [{ key: "atm", label: "ATM" }, { key: "d25", label: "25Δ" }, { key: "d10", label: "10Δ" }] as const;
const TFS = [1, 3, 5, 15] as const;
const PERIODS = [["1", "1 min"], ["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"]] as const;
const f2 = (v: number | null | undefined) => (v == null ? MISSING : v.toFixed(2));
const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");

/** One reading of the sign, without a trade claim. */
export function momentumReading(v: number | null): string {
  if (v == null) return "not available (an IV is missing at one end of the comparison)";
  if (Math.abs(v) < 0.1) return "call and put IV moved by about the same amount";
  return v > 0 ? "call IV strengthened relative to put IV" : "put IV strengthened relative to call IV";
}

/** Worked example from the first complete 25-delta row of the table (the numbers on screen). */
export function momentumExample(d: Mom): string[] {
  for (const [k, label] of [...PERIODS, ["prev", "previous session close"]] as const) {
    const row: IvMomentumChange | null | undefined = k === "prev" ? d.table?.previous_close : d.table?.periods[k];
    const b = row?.d25;
    if (row && b && b.ce_change != null && b.pe_change != null && b.momentum != null) {
      return [
        `Window: ${label}, 25Δ, from ${row.from ?? "?"} to ${d.table?.now}`,
        `CE IV change = ${f2(b.ce_now)} − ${f2(b.ce_then)} = ${sg(b.ce_change)} points`,
        `PE IV change = ${f2(b.pe_now)} − ${f2(b.pe_then)} = ${sg(b.pe_change)} points`,
        `IV momentum = ${sg(b.ce_change)} − (${sg(b.pe_change)}) = ${sg(b.momentum)} points`,
      ];
    }
  }
  return [];
}

export function IvMomentumBody({ expiry }: { expiry: string | null }) {
  const c = useChartColors();
  const [tf, setTf] = useState<(typeof TFS)[number]>(1);
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]["key"]>("d25");
  const q = useQuery({ queryKey: ["ivMomentum", expiry, tf], queryFn: () => api.intradayIvMomentum(expiry!, tf), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">IV momentum could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const d = q.data;
  if (d.status !== "ok" || !d.table) return <p className="text-sm text-muted" data-testid="ivmom-empty">{d.status}.</p>;
  const rows: [string, IvMomentumChange | null | undefined][] = [...PERIODS.map(([k, l]) => [l, d.table!.periods[k]] as [string, IvMomentumChange | undefined]), [`Previous close${d.previous_session ? ` (${d.previous_session})` : ""}`, d.table.previous_close]];
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } };
  const opt = {
    animation: false, tooltip: tip, legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: { left: 46, right: 56, top: 30, bottom: 28 },
    xAxis: { type: "category", data: d.series.map((p) => p.at.slice(11, 16)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } }],
    series: [
      { name: "CE IV", type: "line", showSymbol: false, connectNulls: false, data: d.series.map((p) => p[bucket].ce), lineStyle: { color: c.up, width: 1.6 } },
      { name: "PE IV", type: "line", showSymbol: false, connectNulls: false, data: d.series.map((p) => p[bucket].pe), lineStyle: { color: c.down, width: 1.6 } },
      { name: "NIFTY", type: "line", yAxisIndex: 1, showSymbol: false, data: d.series.map((p) => p.spot), lineStyle: { color: c.muted, width: 1, type: "dashed" } },
    ],
  };
  const stale = d.age_seconds > 300;
  const used = d.series.length;
  return (
    <div className="flex flex-col gap-3" data-testid="ivmom-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span>Expiry {d.expiry} · session {d.session} · {d.samples_in_session} stored samples</span>
          <div role="group" aria-label="Delta" className="flex gap-1">{BUCKETS.map((b) => <button key={b.key} type="button" aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)} className={`min-h-8 rounded-sm border px-2 ${bucket === b.key ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{b.label}</button>)}</div>
          <div role="group" aria-label="Chart interval" className="flex items-center gap-1">Chart every {TFS.map((t) => <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)} className={`min-h-8 rounded-sm border px-2 ${tf === t ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{t}m</button>)}</div>
        </div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="ivmom-stale">The newest stored chain is {Math.round(d.age_seconds / 60)} minutes old.</p>}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-xs" data-testid="ivmom-table">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Versus</th><th className="py-1 text-right font-normal">CE IV now</th><th className="py-1 text-right font-normal">CE IV then</th><th className="py-1 text-right font-normal">CE change</th><th className="py-1 text-right font-normal">PE IV now</th><th className="py-1 text-right font-normal">PE IV then</th><th className="py-1 text-right font-normal">PE change</th><th className="py-1 text-right font-normal">IV momentum</th><th className="py-1 text-right font-normal">NIFTY change</th></tr></thead>
            <tbody>
              {rows.map(([label, row]) => {
                const b = row?.[bucket];
                return (
                  <tr key={label} className="border-t border-rule/50">
                    <td className="py-1 text-muted">{label}{row?.from == null ? " · no snapshot" : ""}</td>
                    <td className="num py-1 text-right text-paper">{f2(b?.ce_now)}</td><td className="num py-1 text-right text-muted">{f2(b?.ce_then)}</td><td className={`num py-1 text-right ${tone(b?.ce_change)}`}>{sg(b?.ce_change)}</td>
                    <td className="num py-1 text-right text-paper">{f2(b?.pe_now)}</td><td className="num py-1 text-right text-muted">{f2(b?.pe_then)}</td><td className={`num py-1 text-right ${tone(b?.pe_change)}`}>{sg(b?.pe_change)}</td>
                    <td className={`num py-1 text-right font-semibold ${tone(b?.momentum)}`} title={momentumReading(b?.momentum ?? null)}>{sg(b?.momentum)}</td>
                    <td className="num py-1 text-right text-muted">{row?.spot_change == null ? MISSING : `${sg(row.spot_change, 1)} (${sg(row.spot_change_pct, 2)}%)`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-paper" data-testid="ivmom-reading">Latest 5-minute {BUCKETS.find((b) => b.key === bucket)!.label} momentum: {momentumReading(d.table.periods["5"]?.[bucket].momentum ?? null)}. This compares prices of volatility; it does not say who is buying or selling.</p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div style={{ height: 300 }} data-testid="ivmom-chart"><EChart option={opt} ariaLabel="Call and put implied volatility through the session" /></div>
        <MethodologyPanel metrics={[METRICS.iv_momentum!]} example={momentumExample(d)}
          freshness={{ updatedAt: d.latest_at, session: d.session, expiry: d.expiry, used, missing: d.excluded, timeframe: `${tf}-minute chart; comparisons against 1, 5, 15, 30, 60 minutes and the previous close` }} />
      </div>
    </div>
  );
}
