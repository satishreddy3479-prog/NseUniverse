import { MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import type { IvSkew, TermSeries } from "../lib/types";
import { EChart, useChartColors } from "./EChart";
import { MethodologyPanel } from "./MethodologyPanel";

const SERIES: { key: string; label: string; unit: "pct" | "pts" }[] = [
  { key: "atm_iv", label: "ATM IV", unit: "pct" }, { key: "call_25d_iv", label: "25Δ call IV", unit: "pct" }, { key: "put_25d_iv", label: "25Δ put IV", unit: "pct" },
  { key: "call_10d_iv", label: "10Δ call IV", unit: "pct" }, { key: "put_10d_iv", label: "10Δ put IV", unit: "pct" }, { key: "skew_25d", label: "25Δ skew (put − call)", unit: "pts" }, { key: "skew_10d", label: "10Δ skew (put − call)", unit: "pts" },
];
const f2 = (v: number | null | undefined) => (v == null ? MISSING : v.toFixed(2));
const sg = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);

/** Worked example of the ATM and 25-delta call term slopes, written from the series on screen. */
export function termExample(ts: Record<string, TermSeries>): string[] {
  const out: string[] = [];
  for (const [k, label] of [["atm_iv", "ATM IV"], ["call_25d_iv", "25Δ call IV"], ["put_10d_iv", "10Δ put IV"]] as const) {
    const s = ts[k];
    if (s?.near && s.far && s.slope_per_30d != null) out.push(`${label}: (${s.far.value.toFixed(2)} − ${s.near.value.toFixed(2)}) / (${s.far.days.toFixed(2)} − ${s.near.days.toFixed(2)}) × 30 = ${sg(s.slope_per_30d)} points per 30 days (far ${s.far.expiry}, near ${s.near.expiry}) → ${s.shape}`);
  }
  return out;
}

export function TermStructureView({ d }: { d: IvSkew }) {
  const c = useChartColors();
  const term = d.term;
  const ts = d.term_structure?.series ?? null;
  const colors = [c.brass, c.up, c.down, c.info, c.muted];
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) };
  const x = term.map((t) => `${t.expiry.slice(5)} (${t.days == null ? "?" : t.days.toFixed(1)}d)`);
  const line = (name: string, key: "atm_iv" | "call_25d_iv" | "put_25d_iv" | "call_10d_iv" | "put_10d_iv", color: string, dash = false) => ({ name, type: "line", symbolSize: 7, connectNulls: false, data: term.map((t) => t[key] ?? null), lineStyle: { color, width: 2, type: dash ? "dashed" : "solid" }, itemStyle: { color } });
  const opt = {
    animation: false, grid: { left: 46, right: 20, top: 40, bottom: 28 }, tooltip: tip,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
    series: [line("ATM IV", "atm_iv", colors[0]!), line("25Δ call IV", "call_25d_iv", colors[1]!), line("25Δ put IV", "put_25d_iv", colors[2]!), line("10Δ call IV", "call_10d_iv", colors[1]!, true), line("10Δ put IV", "put_10d_iv", colors[2]!, true)],
  };
  const skewOpt = {
    animation: false, grid: { left: 46, right: 20, top: 36, bottom: 28 }, tooltip: { ...tip, valueFormatter: (v: number | null) => (v == null ? MISSING : v.toFixed(2)) },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
    series: [{ name: "25Δ skew (put − call)", type: "bar", data: term.map((t) => t.skew_25d ?? null), itemStyle: { color: c.info }, barMaxWidth: 24 }, { name: "10Δ skew (put − call)", type: "bar", data: term.map((t) => t.skew_10d ?? null), itemStyle: { color: c.brass }, barMaxWidth: 24 }],
  };
  return (
    <div data-testid="term-view">
      <div style={{ height: 320 }} data-testid="ivskew-term"><EChart option={opt} ariaLabel="ATM, 25 delta and 10 delta call and put implied volatility by expiry" /></div>
      <div style={{ height: 200 }} data-testid="ivskew-term-skew"><EChart option={skewOpt} ariaLabel="25 and 10 delta skew by expiry" /></div>
      <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[34rem] text-xs" data-testid="ivskew-term-table">
        <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Expiry</th><th className="py-1 text-right font-normal">Days</th><th className="py-1 text-right font-normal">ATM IV</th><th className="py-1 text-right font-normal">25Δ call / put IV</th><th className="py-1 text-right font-normal">10Δ call / put IV</th><th className="py-1 text-right font-normal">25Δ skew</th></tr></thead>
        <tbody>{term.map((t) => <tr key={t.expiry} className="border-t border-rule/50"><td className="py-1 text-paper">{t.expiry}</td><td className="num py-1 text-right text-muted">{t.days == null ? MISSING : t.days.toFixed(2)}</td><td className="num py-1 text-right text-paper">{f2(t.atm_iv)}</td><td className="num py-1 text-right text-muted">{f2(t.call_25d_iv)} / {f2(t.put_25d_iv)}</td><td className="num py-1 text-right text-muted">{f2(t.call_10d_iv)} / {f2(t.put_10d_iv)}</td><td className="num py-1 text-right text-paper">{sg(t.skew_25d)}</td></tr>)}</tbody>
      </table></div>
      {ts ? (
        <div className="mt-3 overflow-x-auto" data-testid="term-slopes">
          <table className="w-full min-w-[40rem] text-xs">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Series</th><th className="py-1 text-right font-normal">Near (expiry, days, value)</th><th className="py-1 text-right font-normal">Far (expiry, days, value)</th><th className="py-1 text-right font-normal">Far − near</th><th className="py-1 text-right font-normal">Term slope / 30 days</th><th className="py-1 text-left pl-3 font-normal">Shape</th></tr></thead>
            <tbody>{SERIES.map(({ key, label }) => { const s = ts[key]; return (
              <tr key={key} className="border-t border-rule/50" data-testid={`term-slope-${key}`}><td className="py-1 text-paper">{label}</td>
                <td className="num py-1 text-right text-muted">{s?.near ? `${s.near.expiry.slice(5)}, ${s.near.days.toFixed(1)}d, ${s.near.value.toFixed(2)}` : MISSING}</td><td className="num py-1 text-right text-muted">{s?.far ? `${s.far.expiry.slice(5)}, ${s.far.days.toFixed(1)}d, ${s.far.value.toFixed(2)}` : MISSING}</td>
                <td className="num py-1 text-right">{sg(s?.difference)}</td><td className="num py-1 text-right text-paper">{sg(s?.slope_per_30d)}</td><td className="py-1 pl-3 text-muted">{s?.shape ?? MISSING}</td></tr>); })}</tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">Left out of a slope: {Object.entries(ts).flatMap(([k, s]) => s.left_out.map((l) => `${SERIES.find((x) => x.key === k)?.label ?? k} ${l.expiry} (${l.reason})`)).join("; ") || "nothing"}.</p>
        </div>
      ) : <p className="mt-2 text-xs text-muted">Term slopes are not available for this snapshot.</p>}
      <MethodologyPanel metrics={[METRICS.term_slope!]} example={ts ? termExample(ts) : []}
        freshness={{ updatedAt: d.at ?? null, session: d.session ?? null, expiry: d.expiry ?? null, used: term.length, missing: ts ? Object.values(ts).reduce((a, s) => a + s.left_out.length, 0) : null, timeframe: "chains stored within 5 minutes of the chosen one; same delta interpolation for every expiry" }} />
    </div>
  );
}
