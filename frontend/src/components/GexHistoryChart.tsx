import { useQuery } from "@tanstack/react-query";
import { fmtInt, MISSING } from "../lib/format";
import { fmtCrore } from "../lib/gammaAnalysis";
import { api } from "../lib/api";
import { METRICS } from "../lib/metricRegistry";
import type { GexHistory } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { MethodologyPanel } from "./MethodologyPanel";

const hhmm = (iso: string) => iso.slice(11, 16);

/** Worked example from the newest rebuilt snapshot: net = call + put, and where the flip, walls and peak were. */
export function gexHistoryExample(d: GexHistory): string[] {
  const p = d.points[d.points.length - 1];
  if (!p || p.ce == null || p.pe == null) return [];
  return [
    `${d.universe} universe at ${hhmm(p.at)} (NIFTY ${fmtInt(Math.round(p.spot))}): call GEX ${fmtCrore(p.ce)} cr, put GEX ${fmtCrore(p.pe)} cr (put sign negative)`,
    `Net = ${fmtCrore(p.ce)} + (${fmtCrore(p.pe)}) = ${fmtCrore(p.ce + p.pe)} cr (strikes with both sides: ${fmtCrore(p.net)}); absolute = ${fmtCrore(p.abs)} cr; near-ATM net = ${fmtCrore(p.near_net)} cr`,
    `Gamma flip ${p.flip == null ? "none within ±8%" : `${fmtInt(Math.round(p.flip))} (${(((p.flip - p.spot) / p.spot) * 100).toFixed(2)}% from spot)`}; call wall ${p.call_wall ?? MISSING}, put wall ${p.put_wall ?? MISSING}, peak gamma ${p.peak ?? MISSING}`,
  ];
}

export function GexHistoryChart({ expiry, universe }: { expiry: string; universe: "fixed" | "dynamic" | "full" }) {
  const c = useChartColors();
  const q = useQuery({ queryKey: ["gexHistory", expiry, universe], queryFn: () => api.intradayGexHistory(expiry, universe), staleTime: 120_000, retry: false });
  const d = q.data;
  const pts = d?.status === "ok" && Array.isArray(d.points) ? d.points : [];
  const opt = pts.length < 2 ? null : {
    animation: false, grid: { left: 56, right: 60, top: 36, bottom: 30 },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: pts.map((p) => hhmm(p.at)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", position: "right", axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { show: false } }],
    series: [
      { name: "NIFTY", type: "line", showSymbol: false, data: pts.map((p) => p.spot), lineStyle: { color: c.brass, width: 2 } },
      { name: "Gamma flip", type: "line", showSymbol: false, connectNulls: false, data: pts.map((p) => p.flip), lineStyle: { color: c.info, width: 1.2, type: "dashed" } },
      { name: "Call wall", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.call_wall), lineStyle: { color: c.down, width: 1, type: "dotted" } },
      { name: "Put wall", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.put_wall), lineStyle: { color: c.up, width: 1, type: "dotted" } },
      { name: "Peak gamma", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.peak), lineStyle: { color: c.muted, width: 1, type: "dotted" } },
      { name: `Net GEX (${universe})`, type: "bar", yAxisIndex: 1, barMaxWidth: 8, data: pts.map((p) => ({ value: p.net, itemStyle: { color: (p.net ?? 0) >= 0 ? c.up : c.down, opacity: 0.45 } })) },
    ],
  };
  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="gexhist-section">
      <h2 className="mb-1 text-sm font-semibold text-paper">GEX and gamma flip rebuilt from the stored chains{d?.session ? ` · ${d.session}` : ""}</h2>
      {q.isLoading && <div className="h-32 animate-pulse rounded-sm bg-slate-2" aria-label="Loading" />}
      {q.isError && <p role="alert" className="text-sm text-down">The GEX history could not be rebuilt: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>}
      {d && d.status !== "ok" && <p className="text-sm text-muted" data-testid="gexhist-empty">{d.status}.</p>}
      {opt && <div style={{ height: 300 }} data-testid="gexhist-chart"><EChart option={opt} ariaLabel="NIFTY, gamma flip, walls, peak gamma and net GEX rebuilt at each stored snapshot" /></div>}
      {d?.status === "ok" && (
        <>
          <p className="text-[11px] text-muted" data-testid="gexhist-note">{pts.length} snapshots rebuilt ({d.universe}; opening ATM {d.opening_atm ?? MISSING}); {d.skipped?.length ?? 0} skipped because the chain could not be solved. Units: {d.units}. Nothing here is stored or filled: it is recomputed from the stored chain of each snapshot.</p>
          <MethodologyPanel metrics={[METRICS.gex_reconstruction!]} example={gexHistoryExample(d)}
            freshness={{ updatedAt: pts.length ? pts[pts.length - 1]!.at : null, session: d.session ?? null, expiry: d.expiry, used: pts.length, missing: d.skipped?.length ?? 0, timeframe: "5-minute snapshots of the session" }} />
        </>
      )}
    </div>
  );
}
