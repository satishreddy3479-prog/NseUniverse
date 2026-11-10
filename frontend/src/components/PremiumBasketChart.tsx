import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import type { PremiumBasketPoint, PremiumBaskets } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { MethodologyPanel } from "./MethodologyPanel";

const WINDOWS = [["5", "ATM ±5"], ["10", "ATM ±10"], ["20", "ATM ±20"], ["all", "Full chain"]] as const;
const VIEWS = [["abs", "Absolute premium"], ["idx", "Normalised (open = 100)"], ["chg", "Change since open"], ["pct", "% change since open"]] as const;
const f = (v: number | null | undefined, d = 2) => (v == null ? MISSING : v.toFixed(d));
const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const hhmm = (iso: string) => iso.slice(11, 16);

/** Worked example from the newest point: the change, percentage and asymmetry restated from the totals on screen. */
export function premiumExample(d: PremiumBaskets): string[] {
  const first = d.points.find((p) => p.ce != null && p.pe != null), last = d.points[d.points.length - 1];
  if (!first || !last || last.ce == null || last.pe == null || last.ce_change == null || last.pe_change == null) return [];
  return [
    `Basket: ${d.basket}; ${last.strikes} strikes, ${last.ce_n} call and ${last.pe_n} put prices counted at ${hhmm(last.at)}`,
    `CE premium ${f(first.ce)} → ${f(last.ce)}: change ${sg(last.ce_change)}, % = (${f(last.ce)} / ${f(first.ce)} − 1) × 100 = ${sg(last.ce_pct)}%`,
    `PE premium ${f(first.pe)} → ${f(last.pe)}: change ${sg(last.pe_change)}, % = ${sg(last.pe_pct)}%`,
    last.asymmetry.ratio == null ? `Asymmetry: not shown (${last.asymmetry.note})` : `Asymmetry = |${f(last.pe_change)}| / |${f(last.ce_change)}| = ${last.asymmetry.ratio.toFixed(3)}`,
    d.kind === "dynamic" ? `Normalised index uses the mean premium per strike: CE ${f(last.ce_mean)} / ${f(first.ce_mean)} × 100 = ${f(last.ce_idx, 1)}` : `Normalised index = total / opening total × 100: CE ${f(last.ce)} / ${f(first.ce)} × 100 = ${f(last.ce_idx, 1)}`,
  ];
}

export function PremiumBasketChart({ expiry }: { expiry: string }) {
  const c = useChartColors();
  const [win, setWin] = useState<string>("10");
  const [kind, setKind] = useState<"fixed" | "dynamic">("fixed");
  const [view, setView] = useState<(typeof VIEWS)[number][0]>("abs");
  const q = useQuery({ queryKey: ["premBasket", expiry, win, kind], queryFn: () => api.intradayPremiumBaskets(expiry, win, kind), refetchInterval: 30_000, retry: false });
  const btn = (on: boolean) => `min-h-8 rounded-sm border px-2 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
  const d = q.data;
  const pts: PremiumBasketPoint[] = d?.status === "ok" && Array.isArray(d.points) ? d.points : [];
  const pick = (p: PremiumBasketPoint, side: "ce" | "pe"): number | null => (view === "abs" ? p[side] : view === "idx" ? p[`${side}_idx`] : view === "chg" ? p[`${side}_change`] : p[`${side}_pct`]);
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } };
  const opt = pts.length < 2 ? null : {
    animation: false, grid: { left: 56, right: 60, top: 36, bottom: 40 }, tooltip: tip,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: pts.map((p) => hhmm(p.at)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } }],
    series: [
      { name: "CE premium", type: "line", showSymbol: false, connectNulls: false, data: pts.map((p) => pick(p, "ce")), lineStyle: { color: c.up, width: 2 } },
      { name: "PE premium", type: "line", showSymbol: false, connectNulls: false, data: pts.map((p) => pick(p, "pe")), lineStyle: { color: c.down, width: 2 } },
      { name: "NIFTY", type: "line", yAxisIndex: 1, showSymbol: false, data: pts.map((p) => p.spot), lineStyle: { color: c.muted, width: 1, type: "dashed" } },
    ],
  };
  const last = pts[pts.length - 1];
  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="prem-chart-section">
      <h2 className="mb-2 text-sm font-semibold text-paper">Aggregate CE and PE premium through the session</h2>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <div role="group" aria-label="Basket size" className="flex gap-1">{WINDOWS.map(([k, l]) => <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)} className={btn(win === k)}>{l}</button>)}</div>
        <div role="group" aria-label="Basket type" className="flex gap-1">{([["fixed", "Fixed (opening strikes)"], ["dynamic", "Dynamic (recentred)"]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={btn(kind === k)}>{l}</button>)}</div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">{VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)} className={btn(view === k)}>{l}</button>)}</div>
      </div>
      {q.isLoading && <div className="mt-2 h-40 animate-pulse rounded-sm bg-slate-2" aria-label="Loading" />}
      {q.isError && <p role="alert" className="mt-2 text-sm text-down">The premium chart could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>}
      {d && d.status !== "ok" && <p className="mt-2 text-sm text-muted" data-testid="prem-empty">{d.status}.</p>}
      {d?.status === "ok" && Array.isArray(d.points) && (
        <>
          <p className="mt-2 text-xs text-warn" data-testid="prem-kind">{d.basket}. {kind === "fixed" ? "The same strikes all session: changes compare like with like." : "The strike set follows NIFTY, so the total jumps when it re-centres; the normalised view uses the mean premium per strike to remove that."}</p>
          {opt ? <div style={{ height: 300 }} data-testid="prem-chart"><EChart option={opt} ariaLabel="Aggregate call and put premium with NIFTY" /></div> : <p className="mt-2 text-sm text-muted">Fewer than two snapshots with prices.</p>}
          {last && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-8" data-testid="prem-cards">
              {[["CE premium", f(last.ce)], ["PE premium", f(last.pe)], ["CE change", sg(last.ce_change)], ["PE change", sg(last.pe_change)], ["CE % change", `${sg(last.ce_pct)}%`], ["PE % change", `${sg(last.pe_pct)}%`], ["PE/CE asymmetry", last.asymmetry.ratio == null ? MISSING : last.asymmetry.ratio.toFixed(2)], ["Strikes (CE / PE priced)", `${last.ce_n} / ${last.pe_n}`]].map(([l, v]) => <div key={l} className="rounded-sm bg-slate-2 p-2" title={l === "PE/CE asymmetry" ? (last.asymmetry.note ?? "|PE change| / |CE change| since the first snapshot") : undefined}><div className="text-[11px] text-muted">{l}</div><div className="num text-paper">{v}</div></div>)}
            </div>
          )}
          <MethodologyPanel metrics={[METRICS.premium_chart!]} example={premiumExample(d)}
            freshness={{ updatedAt: d.latest_at, session: d.session, expiry: d.expiry, used: pts.length, missing: d.snapshots - pts.length, timeframe: `5-minute snapshots since the first of ${d.session}; ${d.basket}` }} />
        </>
      )}
    </div>
  );
}
