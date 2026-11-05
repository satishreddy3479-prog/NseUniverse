import { useMemo, useState, type ReactNode } from "react";
import { EChart, useChartColors } from "../EChart";
import { useDash } from "./DashContext";
import { compactIN } from "../../lib/analytics";
import { fmtInt, fmtPrice } from "../../lib/format";
import { buildupOf, chainGreeks, exposures, peCeDifference, smartOiSummary, type Buildup, type DiffMetric } from "../../lib/optionTools";
import { marketClockMs } from "../../lib/session";
import { useLiveSpot } from "../../lib/useLive";
import type { ChartColors } from "../../lib/chartOptions";

/** Widgets of the Options Lab tools. Each says what it is built from and how many strikes it could not use. */
function Guard({ children }: { children: ReactNode }) {
  const d = useDash();
  if (d.snapshot) return <>{children}</>;
  if (d.chain.isPending && d.expiry) return <p className="p-3 text-sm text-muted">Loading snapshot…</p>;
  return <p className="p-3 text-sm text-muted">{d.noSnapshot ? "No snapshot stored for this expiry yet." : "No option-chain data to show."}</p>;
}
const Note = ({ children }: { children: ReactNode }) => <p className="mt-1 text-[11px] text-muted">{children}</p>;
const axis = (c: ChartColors) => ({ axisLabel: { color: c.muted, fontSize: 11 }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { lineStyle: { color: c.rule } } });

const TONE: Record<Buildup, string> = { "Long buildup": "bg-up/20 text-up", "Short covering": "bg-up/10 text-up", "Short buildup": "bg-down/20 text-down", "Long unwinding": "bg-down/10 text-down" };
const SHORT: Record<Buildup, string> = { "Long buildup": "LB", "Short buildup": "SB", "Short covering": "SC", "Long unwinding": "LU" };

export function SmartOiWidget() {
  const d = useDash();
  const rows = d.view;
  const sum = useMemo(() => smartOiSummary(rows), [rows]);
  const chip = (q: (typeof rows)[number]["call"], on: boolean) => {
    if (!on) return <td />;
    const b = buildupOf(q);
    return b ? (
      <td className="px-1"><span className={`inline-block min-w-9 rounded-sm px-1.5 py-0.5 text-center text-[11px] font-semibold ${TONE[b.label]}`} title={`${b.label}: price ${b.priceChange >= 0 ? "+" : "−"}${fmtPrice(Math.abs(b.priceChange))}, OI ${b.oiChange > 0 ? "+" : "−"}${compactIN(Math.abs(b.oiChange))}`}>{SHORT[b.label]}</span>
        <span className={`num ml-1.5 text-xs ${b.priceChange >= 0 ? "text-up" : "text-down"}`}>{b.priceChangePct == null ? "" : `${b.priceChangePct >= 0 ? "+" : ""}${b.priceChangePct.toFixed(0)}%`}</span></td>
    ) : <td className="px-1 text-muted">—</td>;
  };
  return (
    <Guard>
      <div className="flex h-full flex-col">
        <div className="mb-2 flex flex-wrap gap-2" aria-label="Buildup counts">
          {(Object.keys(TONE) as Buildup[]).map((l) => (
            <div key={l} className={`rounded-sm px-2 py-1 text-xs ${TONE[l]}`}><span className="font-semibold">{l}</span> <span className="num">calls {sum.counts[l].ce} · puts {sum.counts[l].pe}</span></div>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm" aria-label="Smart OI by strike">
            <thead className="sticky top-0 bg-slate text-xs text-muted"><tr><th className="text-left font-normal">Call buildup</th><th className="text-right font-normal">Call OI chg</th><th className="px-3 text-center font-normal">Strike</th><th className="text-left font-normal">Put OI chg</th><th className="text-left font-normal">Put buildup</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.strike} className={`border-t border-rule/50 ${r.strike === d.atmStrike ? "bg-brass/10" : ""}`}>
                  {chip(r.call, d.showCalls)}
                  <td className="num text-right text-xs">{d.showCalls && r.call?.oi_change != null ? `${r.call.oi_change > 0 ? "+" : "−"}${compactIN(Math.abs(r.call.oi_change))}` : ""}</td>
                  <td className="num px-3 text-center font-semibold">{fmtInt(r.strike)}</td>
                  <td className="num text-xs">{d.showPuts && r.put?.oi_change != null ? `${r.put.oi_change > 0 ? "+" : "−"}${compactIN(Math.abs(r.put.oi_change))}` : ""}</td>
                  {chip(r.put, d.showPuts)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>LB long buildup (price up, OI up) · SB short buildup (price down, OI up) · SC short covering (price up, OI down) · LU long unwinding (price down, OI down). Each contract's own price against its previous close and its OI against the previous day's. {sum.unclassified > 0 ? `${sum.unclassified} contracts have no previous close or no change and carry no label.` : ""}</Note>
      </div>
    </Guard>
  );
}

const METRICS: { id: DiffMetric; label: string }[] = [{ id: "oi", label: "Open interest" }, { id: "oiChange", label: "OI change" }, { id: "volume", label: "Volume" }];

export function PeCeWidget() {
  const d = useDash();
  const c = useChartColors();
  const [metric, setMetric] = useState<DiffMetric>("oi");
  const r = useMemo(() => peCeDifference(d.view, metric), [d.view, metric]);
  const opt = useMemo(() => ({
    animation: false, grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => compactIN(v) },
    xAxis: { type: "category", data: r.points.map((p) => p.strike), ...axis(c), splitLine: { show: false } },
    yAxis: { type: "value", ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => compactIN(v) } },
    series: [{ type: "bar", name: "Put − call", data: r.points.map((p) => ({ value: p.diff, itemStyle: { color: p.diff >= 0 ? c.up : c.down } })),
      markLine: d.atmStrike != null && r.points.some((p) => p.strike === d.atmStrike) ? { symbol: "none", label: { formatter: "ATM", color: c.brass }, lineStyle: { color: c.brass, type: "dashed" }, data: [{ xAxis: String(d.atmStrike) }] } : undefined }],
  }), [r, c, d.atmStrike]);
  return (
    <Guard>
      <div className="flex h-full flex-col">
        <div className="mb-1 flex flex-wrap items-center gap-3 text-sm">
          <select aria-label="Measure" value={metric} onChange={(e) => setMetric(e.target.value as DiffMetric)} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-2">{METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          <span className="text-muted">Total put − call: <b className={r.total >= 0 ? "text-up" : "text-down"}>{r.total >= 0 ? "+" : "−"}{compactIN(Math.abs(r.total))}</b></span>
        </div>
        {r.points.length === 0 ? <p className="p-3 text-sm text-muted">No strike has both a call and a put value for this measure.</p> : <div className="min-h-0 flex-1"><EChart ariaLabel="Put minus call by strike" option={opt} /></div>}
        <Note>Put minus call, strike by strike; green where puts exceed calls. {r.skipped > 0 ? `${r.skipped} strikes are left out because one side has no value.` : ""}</Note>
      </div>
    </Guard>
  );
}

/** Greeks of the chain at the right moment: live prices and time when the stream is fresh, otherwise the stored snapshot's. */
function useChainGreeks() {
  const d = useDash();
  const ls = useLiveSpot();
  const snap = d.snapshot;
  const live = d.liveMode === "fresh" && ls.live;
  const spot = live ? ls.ltp : snap?.underlying_ltp ?? null;
  const nowMs = snap ? marketClockMs(live ? Date.now() : Date.parse(snap.retrieved_at)) : 0;
  const g = useMemo(() => (snap && spot != null && d.expiry ? chainGreeks(d.rows, spot, d.expiry, nowMs) : null), [d.rows, spot, d.expiry, nowMs, snap]);
  return { d, g, spot };
}

const MODEL_NOTE = "Black-76 model, 6 % rate, forward from put-call parity near spot; volatility is solved from each contract's own last price.";

export function IvSkewWidget() {
  const { d, g } = useChainGreeks();
  const c = useChartColors();
  const view = new Set(d.view.map((r) => r.strike));
  const pts = (side: "ce" | "pe") => (g?.strikes ?? []).filter((s) => view.has(s.strike)).map((s) => [s.strike, s[side] ? +(s[side]!.iv * 100).toFixed(2) : null]);
  const opt = useMemo(() => ({
    animation: false, legend: { textStyle: { color: c.muted }, top: 0 }, grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v: number | null) => (v == null ? "—" : `${v}%`) },
    xAxis: { type: "category", data: (g?.strikes ?? []).filter((s) => view.has(s.strike)).map((s) => s.strike), ...axis(c), splitLine: { show: false } },
    yAxis: { type: "value", scale: true, name: "IV %", nameTextStyle: { color: c.muted }, ...axis(c) },
    series: [
      ...(d.showCalls ? [{ type: "line", name: "Call IV", data: pts("ce").map((p) => p[1]), showSymbol: false, connectNulls: false, lineStyle: { color: c.up }, itemStyle: { color: c.up } }] : []),
      ...(d.showPuts ? [{ type: "line", name: "Put IV", data: pts("pe").map((p) => p[1]), showSymbol: false, connectNulls: false, lineStyle: { color: c.down }, itemStyle: { color: c.down } }] : []),
    ],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [g, d.view, d.showCalls, d.showPuts, c]);
  return (
    <Guard>
      <div className="flex h-full flex-col">
        {g == null ? <p className="p-3 text-sm text-muted">Needs a NIFTY level and prices to solve volatility; none is available.</p> : <div className="min-h-0 flex-1"><EChart ariaLabel="Implied volatility by strike" option={opt} /></div>}
        <Note>{MODEL_NOTE} {g && g.skipped > 0 ? `${g.skipped} contracts gave no volatility (no price, or outside what the model fits) and are gaps in the line.` : ""}</Note>
      </div>
    </Guard>
  );
}

function ExposureWidget({ kind }: { kind: "gamma" | "vega" }) {
  const { d, g, spot } = useChainGreeks();
  const c = useChartColors();
  const r = useMemo(() => (g && spot != null ? exposures(d.view, g.strikes, spot, kind) : null), [g, d.view, spot, kind]);
  // a strike with no usable price has no exposure: it is left out of the total and counted, never added as zero
  const total = (k: "call" | "put") => (r?.points ?? []).reduce((t, p) => t + (p[k] ?? 0), 0);
  const used = (k: "call" | "put") => (r?.points ?? []).filter((p) => p[k] != null).length;
  const of = (k: "call" | "put") => (used(k) < (r?.points.length ?? 0) ? ` (${used(k)} of ${r?.points.length} strikes)` : "");
  const opt = useMemo(() => ({
    animation: false, legend: { textStyle: { color: c.muted }, top: 0 }, grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number | null) => (v == null ? "—" : compactIN(v)) },
    xAxis: { type: "category", data: (r?.points ?? []).map((p) => p.strike), ...axis(c), splitLine: { show: false } },
    yAxis: { type: "value", ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => compactIN(v) } },
    series: [
      ...(d.showCalls ? [{ type: "bar", name: "Call", data: (r?.points ?? []).map((p) => p.call), itemStyle: { color: c.up } }] : []),
      ...(d.showPuts ? [{ type: "bar", name: "Put", data: (r?.points ?? []).map((p) => p.put), itemStyle: { color: c.down } }] : []),
      ...(kind === "gamma" && d.showCalls && d.showPuts ? [{ type: "line", name: "Net (call − put)", data: (r?.points ?? []).map((p) => p.net), showSymbol: false, lineStyle: { color: c.brass }, itemStyle: { color: c.brass } }] : []),
    ],
  }), [r, c, d.showCalls, d.showPuts, kind]);
  return (
    <Guard>
      <div className="flex h-full flex-col">
        {r && r.points.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-x-6 text-sm text-muted">
            <span>Calls: <b className="text-up">{compactIN(total("call"))}</b>{of("call")}</span><span>Puts: <b className="text-down">{compactIN(total("put"))}</b>{of("put")}</span>
            {kind === "gamma" && <span>Net (call − put): <b className="text-paper">{compactIN(total("call") - total("put"))}</b></span>}
          </div>
        )}
        {r == null || r.points.length === 0 ? <p className="p-3 text-sm text-muted">No strike has both Greeks and open interest, so nothing is shown.</p> : <div className="min-h-0 flex-1"><EChart ariaLabel={kind === "gamma" ? "Gamma exposure by strike" : "Vega exposure by strike"} option={opt} /></div>}
        <Note>
          {kind === "gamma"
            ? "Gamma × open interest × spot² × 1 %: the rupee value of NIFTY whose delta changes for a 1 % move. Net = call − put is a convention that assumes the market is long calls and short puts; it is not observed positioning. "
            : "Vega per volatility point × open interest: the rupee change in all contracts of a strike for one volatility point. "}
          {MODEL_NOTE} {r && r.skipped > 0 ? `${r.skipped} strikes are left out (no Greeks or no OI).` : ""}
        </Note>
      </div>
    </Guard>
  );
}
export const GexWidget = () => <ExposureWidget kind="gamma" />;
export const VegaWidget = () => <ExposureWidget kind="vega" />;

/** Every contract's own price, implied volatility and vega, so each number the summed charts are built from can be checked one by one. */
export function VegaTableWidget() {
  const { d, g, spot } = useChainGreeks();
  const rows = useMemo(() => {
    const by = new Map((g?.strikes ?? []).map((x) => [x.strike, x]));
    return d.view.map((r) => ({ strike: r.strike, cp: r.call?.ltp ?? null, ci: by.get(r.strike)?.ce?.iv ?? null, cv: by.get(r.strike)?.ce?.vegaPt ?? null,
      pp: r.put?.ltp ?? null, pi: by.get(r.strike)?.pe?.iv ?? null, pv: by.get(r.strike)?.pe?.vegaPt ?? null }));
  }, [d.view, g]);
  const sum = (k: "cv" | "pv") => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const n = (k: "cv" | "pv") => rows.filter((r) => r[k] != null).length;
  const f = (v: number | null, dp = 2) => (v == null ? "—" : v.toFixed(dp));
  return (
    <Guard>
      <div className="flex h-full min-h-0 flex-col">
        {g == null || spot == null ? <p className="p-3 text-sm text-muted">Needs a NIFTY level and prices to solve volatility; none is available.</p> : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm" aria-label="Vega of every call and put">
              <thead className="sticky top-0 bg-slate text-xs text-muted">
                <tr><th className="text-right font-normal">CE price</th><th className="text-right font-normal">CE IV %</th><th className="text-right font-normal text-up">CE vega</th>
                  <th className="px-3 text-center font-normal">Strike</th>
                  <th className="text-right font-normal text-down">PE vega</th><th className="text-right font-normal">PE IV %</th><th className="text-right font-normal">PE price</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.strike} className={`border-t border-rule/50 ${r.strike === d.atmStrike ? "bg-brass/10" : ""}`}>
                    <td className="num text-right">{f(r.cp)}</td><td className="num text-right">{r.ci == null ? "—" : f(r.ci * 100)}</td><td className="num text-right text-up">{f(r.cv)}</td>
                    <td className="num px-3 text-center font-semibold">{fmtInt(r.strike)}</td>
                    <td className="num text-right text-down">{f(r.pv)}</td><td className="num text-right">{r.pi == null ? "—" : f(r.pi * 100)}</td><td className="num text-right">{f(r.pp)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-rule font-semibold"><td /><td className="text-right text-xs font-normal text-muted">sum of {n("cv")}</td><td className="num text-right text-up">{f(sum("cv"))}</td>
                  <td className="px-3 text-center">Total</td><td className="num text-right text-down">{f(sum("pv"))}</td><td className="text-right text-xs font-normal text-muted">sum of {n("pv")}</td><td /></tr>
              </tbody>
            </table>
          </div>
        )}
        <Note>Vega = rupees of option price per one volatility point, for one unit of the contract (no open interest). {MODEL_NOTE} NIFTY {spot == null ? "—" : fmtPrice(spot)}. Strikes: {d.universeLabel}.</Note>
      </div>
    </Guard>
  );
}
