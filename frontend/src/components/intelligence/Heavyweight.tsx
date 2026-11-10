import { useMemo } from "react";
import { Link } from "react-router-dom";
import { fmtTimeIST, MISSING } from "../../lib/format";
import { CVD_TIP, signed, toneOf, type HeavyStock, type Intelligence } from "../../lib/intelligence";
import { EChart, useChartColors } from "../EChart";

const pct = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const n2 = (v: number | null | undefined, d = 2) => (v == null ? MISSING : v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
const CLASS_TONE: Record<string, string> = { "Broad heavyweight buying": "text-up", "Broad heavyweight selling": "text-down", "Narrow heavyweight buying": "text-up", "Narrow heavyweight selling": "text-down", "Heavyweight divergence": "text-warn" };

function Tile({ label, value, sub, tone, tip }: { label: string; value: string; sub?: string; tone?: string; tip?: string }) {
  return <div className="min-w-0 rounded-sm bg-slate-2 px-2.5 py-2" title={tip}><div className="truncate text-[11px] text-muted">{label}</div><div className={`num truncate text-[15px] font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="truncate text-[10px] text-muted">{sub}</div>}</div>;
}

function Row({ s }: { s: HeavyStock }) {
  const f = s.freshness;
  const win = s.windows["15"];
  return (
    <tr className="border-t border-rule/50 align-top" data-testid={`hw-row-${s.symbol}`}>
      <td className="py-1.5 pr-2"><div className="text-paper">{s.symbol}</div><div className="max-w-[9rem] truncate text-[10px] text-muted">{s.name ?? ""}</div></td>
      <td className="num py-1.5 text-right"><div>{n2(s.weight)}%</div>{s.previous_weight != null && <div className="text-[10px] text-muted">was {n2(s.previous_weight)}%</div>}</td>
      <td className={`num py-1.5 text-right ${toneOf(s.change_pct == null ? null : s.change_pct * 100)}`}>{pct(s.change_pct)}</td>
      <td className="num py-1.5 text-right" title={CVD_TIP}><div className={toneOf(s.session.norm)}>{pct(s.session.pct, 1)} <span className="text-[10px] text-muted">session</span></div><div className="text-[10px] text-muted">{win.status === "ok" ? `15 min ${pct(win.pct, 1)}` : "15 min unavailable"}</div></td>
      <td className="num py-1.5 text-right"><div className={toneOf(s.momentum)}>{s.momentum == null ? MISSING : signed(s.momentum, 1)}</div><div className="text-[10px] text-muted">accel {s.acceleration == null ? MISSING : signed(s.acceleration, 1)}</div></td>
      <td className="num py-1.5 text-right"><div>{n2(s.vwap)}</div><div className="text-[10px] text-muted">{s.price_vs_vwap_pct == null ? "" : `price ${pct(s.price_vs_vwap_pct, 2)} vs VWAP`}</div></td>
      <td className="py-1.5 pl-2"><div className={s.bias.startsWith("Buying") ? "text-up" : s.bias.startsWith("Selling") ? "text-down" : "text-muted"}>{s.bias}</div>{s.price_cvd_divergence && <div className="text-[10px] text-warn">{s.price_cvd_divergence}</div>}</td>
      <td className="py-1.5 pl-2 text-[10px]"><div className={f.fresh ? "text-up" : "text-warn"}>{f.feed}{f.age_s != null ? ` · ${Math.round(f.age_s)} s` : ""}</div><div className="text-muted">{f.updated ? fmtTimeIST(f.updated) : MISSING} · {s.methodology}</div><div className="text-muted">classified {f.classified_share == null ? MISSING : `${(f.classified_share * 100).toFixed(0)}%`}</div></td>
    </tr>
  );
}

/** The five largest NIFTY 50 constituents: weights, per-stock CVD proxy, the normalised weighted aggregate, participation and the divergence with NIFTY. */
export function HeavyweightPanel({ d }: { d: Intelligence }) {
  const h = d.heavyweights;
  const c = useChartColors();
  const lineOpt = useMemo(() => !h || h.series.filter((x) => x.w15 != null || x.session != null).length < 2 ? null : {
    animation: false, grid: { left: 46, right: 56, top: 34, bottom: 30 },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: h.series.map((x) => fmtTimeIST(x.t)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", min: -100, max: 100, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", scale: true, position: "right", axisLabel: { color: c.muted }, splitLine: { show: false } }],
    series: [
      { name: "Aggregate session (proxy)", type: "line", showSymbol: false, connectNulls: false, data: h.series.map((x) => x.session), lineStyle: { color: c.brass, width: 2 } },
      { name: "Aggregate 15 min (proxy)", type: "line", showSymbol: false, connectNulls: false, data: h.series.map((x) => x.w15), lineStyle: { color: c.info, width: 1.5 } },
      { name: "Aggregate 5 min (proxy)", type: "line", showSymbol: false, connectNulls: false, data: h.series.map((x) => x.w5), lineStyle: { color: c.up, width: 1, type: "dashed" } },
      { name: "NIFTY", type: "line", yAxisIndex: 1, showSymbol: false, connectNulls: true, data: h.series.map((x) => x.spot), lineStyle: { color: c.muted, width: 1 } },
    ],
  }, [h, c]);
  const barOpt = useMemo(() => !h || h.stocks.every((s) => s.contribution_pct == null) ? null : {
    animation: false, grid: { left: 90, right: 24, top: 8, bottom: 22 },
    tooltip: { trigger: "item", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "value", axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
    yAxis: { type: "category", data: h.stocks.map((s) => s.symbol), axisLabel: { color: c.paper }, axisLine: { lineStyle: { color: c.rule } } },
    series: [{ type: "bar", data: h.stocks.map((s) => ({ value: s.contribution_pct, itemStyle: { color: (s.contribution_pct ?? 0) >= 0 ? c.up : c.down } })) }],
  }, [h, c]);

  if (!h || !h.available) {
    return <section aria-label="Heavyweight intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="hw-panel">Heavyweight intelligence: {h?.reason ?? "no heavyweight flow is tracked yet"}. Nothing is estimated in its place.</section>;
  }
  const a = h.aggregate, p = h.participation, q = h.quality, w = q.weights;
  const sc = (k: "session" | "5" | "15" | "30") => a[k];
  const tile = (label: string, k: "session" | "5" | "15" | "30") => <Tile label={label} value={sc(k).score == null ? "unavailable" : signed(sc(k).score, 0)} tone={sc(k).score == null ? "text-warn" : toneOf(sc(k).score)} sub={sc(k).score == null ? sc(k).status : `${sc(k).valid} of ${sc(k).of} stocks${sc(k).status.startsWith("PARTIAL") ? " (PARTIAL)" : ""}`} tip={CVD_TIP} />;
  return (
    <section aria-label="Heavyweight intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="hw-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Heavyweight Intelligence <span className="font-normal text-muted">· is NIFTY supported by its five largest constituents?</span> <span className="ml-1 rounded-sm border border-warn/40 px-1 text-[10px] font-normal text-warn" title={CVD_TIP} data-testid="hw-proxy">CVD PROXY</span></h2>
        <Link to="/tools/future-flow" className="text-xs text-info hover:underline">Open the flow analysis →</Link>
      </div>
      <p className="mt-1 text-[11px] text-muted" data-testid="hw-quality">{q.valid} of {q.of} heavyweights valid ({(q.weight_share * 100).toFixed(0)}% of the top-five weight){!q.aggregate_available && " · aggregate unavailable: never shown as a five-stock figure"}. Weights {w.as_of ? `as of ${w.as_of} (${w.source ?? "source unknown"}${w.rolled_to ? `, rolled to ${w.rolled_to} prices` : ""})` : "not available"}{w.approximate ? " · APPROXIMATE" : ""}{w.basis ? ` · ${w.basis}` : ""}.</p>
      {w.stale && <p role="status" className="text-xs text-warn" data-testid="hw-stale-weights">The index weights are {w.age_days} days old: a newer official composition has not been loaded, so the top-five selection and weighting may be out of date.</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {tile("Aggregate session", "session")}{tile("Aggregate 5 min", "5")}{tile("Aggregate 15 min", "15")}{tile("Aggregate 30 min", "30")}
        <Tile label="Aggregate momentum" value={a.momentum == null ? MISSING : signed(a.momentum, 1)} tone={toneOf(a.momentum)} sub="5-min less 15-min aggregate" />
        <Tile label="Aggregate acceleration" value={a.acceleration == null ? MISSING : signed(a.acceleration, 1)} tone={toneOf(a.acceleration)} sub="5-min aggregate vs 5 min ago" />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="hw-nifty">
        <Tile label="NIFTY (15 min)" value={pct(h.nifty.change_15m_pct)} tone={toneOf(h.nifty.change_15m_pct == null ? null : h.nifty.change_15m_pct * 100)} sub="from stored samples" />
        <Tile label="NIFTY (day)" value={pct(h.nifty.day_change_pct)} />
        <Tile label="NIFTY vs VWAP" value={h.nifty.vwap_side ?? MISSING} sub="the future's own VWAP" />
        <Tile label="Heavyweights vs index" value={h.relative_strength_pct == null ? MISSING : `${h.relative_strength_pct >= 0 ? "+" : "−"}${Math.abs(h.relative_strength_pct).toFixed(2)} pts`} sub="weighted change less index" />
        <div className="col-span-2 min-w-0 rounded-sm bg-slate-2 px-2.5 py-2 sm:col-span-3 lg:col-span-2" data-testid="hw-participation"><div className="text-[11px] text-muted">Participation</div>
          <div className={`text-[15px] font-semibold ${CLASS_TONE[p.class] ?? "text-paper"}`}>{p.class}</div>
          <div className="text-[10px] text-muted">{p.positive == null ? p.reason : `${p.positive} buying · ${p.negative} selling · ${p.neutral} neutral of ${p.valid} valid · weight ${((p.weight_share_positive ?? 0) * 100).toFixed(0)}% buying / ${((p.weight_share_negative ?? 0) * 100).toFixed(0)}% selling${p.top_contributor ? ` · largest ${p.top_contributor.symbol} (${(p.top_contributor.share * 100).toFixed(0)}% of that side)` : ""}`}</div></div>
      </div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[52rem] text-xs" data-testid="hw-table">
        <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Stock</th><th className="py-1 text-right font-normal">Index weight</th><th className="py-1 text-right font-normal">Price change</th><th className="py-1 text-right font-normal" title={CVD_TIP}>CVD (proxy)</th><th className="py-1 text-right font-normal">CVD momentum</th><th className="py-1 text-right font-normal">VWAP</th><th className="py-1 pl-2 font-normal">Bias</th><th className="py-1 pl-2 font-normal">Feed and freshness</th></tr></thead>
        <tbody>{h.stocks.map((s) => <Row key={s.symbol} s={s} />)}</tbody></table></div>
      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>{lineOpt ? <div style={{ height: 230 }}><EChart option={lineOpt} ariaLabel="Aggregate heavyweight CVD proxy against NIFTY through the session" /></div> : <p className="text-xs text-muted" data-testid="hw-no-chart">The aggregate series needs at least two stored minutes with a valid aggregate; none is reconstructed.</p>}</div>
        <div>{barOpt ? <div style={{ height: 230 }}><EChart option={barOpt} ariaLabel="Share of heavyweight buying and selling pressure by stock" /></div> : <p className="text-xs text-muted">No stock has a valid reading to show a contribution.</p>}<p className="text-[10px] text-muted">Contribution = index weight × normalised CVD, as a share of the absolute total.</p></div>
      </div>
      <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer text-info">Method and limits</summary>
        <p className="mt-1">{h.method}. Normalised CVD = 100 × tanh(window CVD % ÷ 25); the aggregate is the index-weighted mean over valid stocks only, and needs at least 3 stocks and 60% of the weight.</p>
        <ul className="mt-1 list-disc pl-5">{h.limits.map((l) => <li key={l}>{l}</li>)}</ul></details>
    </section>
  );
}
