import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { fmtInt, MISSING } from "../../lib/format";
import { fmtCrore } from "../../lib/gammaAnalysis";
import { CVD_TIP, GEX_TIP, VIX_LABEL, type Intelligence } from "../../lib/intelligence";

const n = (v: number | null | undefined, d = 2) => (v == null ? MISSING : v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);

function Block({ id, title, link, open, children }: { id: string; title: string; link: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid={`mi-detail-${id}`}>
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm font-semibold text-paper">{title}<Link to={link} onClick={(e) => e.stopPropagation()} className="text-xs font-normal text-info hover:underline">Open the full analysis →</Link></summary>
      <div className="border-t border-rule px-4 py-3 text-xs">{children}</div>
    </details>
  );
}
const Kv = ({ k, v, tone, tip }: { k: string; v: string; tone?: string; tip?: string }) => <div className="min-w-0" title={tip}><div className="text-[11px] text-muted">{k}</div><div className={`num truncate text-sm ${tone ?? "text-paper"}`}>{v}</div></div>;
const Note = ({ children }: { children: ReactNode }) => <p className="mt-2 text-[11px] text-muted">{children}</p>;
const strikes = (xs: { strike: number; change: number }[]) => (xs.length ? xs.map((x) => `${x.strike} (${sg(x.change, 0)})`).join(", ") : "none");

export function DetailPanels({ d }: { d: Intelligence }) {
  const p = d.panels;
  return (
    <section aria-label="Detailed intelligence" className="flex flex-col gap-2" data-testid="mi-details">
      <Block id="options" title="Options intelligence" link="/tools/strike-positioning">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Kv k="CE OI (ATM ±10)" v={fmtInt(p.options.ce_oi)} /><Kv k="PE OI (ATM ±10)" v={fmtInt(p.options.pe_oi)} /><Kv k="CE OI change" v={sg(p.options.ce_oi_change, 0)} /><Kv k="PE OI change" v={sg(p.options.pe_oi_change, 0)} />
          <Kv k="PCR (OI)" v={n(p.options.pcr_oi)} /><Kv k="PCR now vs first sample" v={`${n(p.options.pcr_oi)} / ${n(p.options.pcr_first)}`} />
          <Kv k="Highest call OI (resistance)" v={String(p.options.max_ce_oi_strike ?? MISSING)} tone="text-down" /><Kv k="Highest put OI (support)" v={String(p.options.max_pe_oi_strike ?? MISSING)} tone="text-up" />
        </div>
        <dl className="mt-2 grid gap-1 sm:grid-cols-2"><div><dt className="inline text-muted">Largest call additions: </dt><dd className="inline text-paper">{strikes(p.options.largest_call_additions)}</dd></div><div><dt className="inline text-muted">Largest put additions: </dt><dd className="inline text-paper">{strikes(p.options.largest_put_additions)}</dd></div>
          <div><dt className="inline text-muted">Largest call unwinding: </dt><dd className="inline text-paper">{strikes(p.options.largest_call_unwinding)}</dd></div><div><dt className="inline text-muted">Largest put unwinding: </dt><dd className="inline text-paper">{strikes(p.options.largest_put_unwinding)}</dd></div></dl>
        {p.options.demand.length > 0 && <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[34rem]"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Group</th><th className="py-1 font-normal">Reading (15 min)</th><th className="py-1 text-right font-normal">OI %</th><th className="py-1 text-right font-normal">Premium %</th><th className="py-1 text-right font-normal">IV chg</th></tr></thead>
          <tbody>{p.options.demand.map((x) => <tr key={x.side + x.group} className="border-t border-rule/50"><td className="py-1 text-paper">{x.side === "CE" ? "Calls" : "Puts"} {x.group === "deep" ? "deep OTM" : "OTM"}</td><td className="py-1 text-muted">{x.label}</td><td className="num py-1 text-right">{sg(x.summary.oi_pct, 1)}</td><td className="num py-1 text-right">{sg(x.summary.premium_pct, 1)}</td><td className="num py-1 text-right">{sg(x.summary.iv_change, 2)}</td></tr>)}</tbody></table></div>}
        <Note>{p.options.note} Expiry-wise positioning and OI migration are on the linked pages (one expiry is analysed at a time here: {d.expiry ?? MISSING}).</Note>
      </Block>
      <Block id="gex" title="Gamma (modelled) and Vega intelligence" link="/tools/gamma-exposure">
        {p.gex.available ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Kv k="Net GEX (modelled)" v={`${fmtCrore(p.gex.net)} cr`} tone={(p.gex.net ?? 0) >= 0 ? "text-up" : "text-down"} /><Kv k="CE GEX" v={`${fmtCrore(p.gex.ce)} cr`} /><Kv k="PE GEX" v={`${fmtCrore(p.gex.pe)} cr`} /><Kv k="Gamma regime" v={p.gex.regime ?? MISSING} />
            <Kv k="Gamma flip (modelled)" v={p.gex.flip == null ? "none within ±8%" : `${fmtInt(Math.round(p.gex.flip))} (${sg(p.gex.flip_distance_pct)}% from spot)`} /><Kv k="Call wall / put wall" v={`${p.gex.call_wall ?? MISSING} / ${p.gex.put_wall ?? MISSING}`} /><Kv k="Peak gamma" v={String(p.gex.peak ?? MISSING)} /><Kv k="Near-ATM net GEX" v={`${fmtCrore(p.gex.near_net)} cr`} />
            <Kv k="Net GEX change (15 min)" v={p.gex.net_change_15m == null ? MISSING : `${sg(p.gex.net_change_15m, 1)} cr (${sg(p.gex.net_change_pct, 0)}%)`} /><Kv k="GEX-price relationship" v={p.gex.relationship ?? MISSING} />
          </div>
        ) : <p className="text-muted">No rebuilt GEX snapshot is available.</p>}
        <Note><span title={GEX_TIP}>{p.gex.label ?? "Modelled GEX exposure (not observed dealer positioning)"}.</span> {p.gex.methodology ?? "GEX is a model; dealer positioning is not observed."} Universe: {p.gex.universe ?? "dynamic ATM ±10"}, rebuilt from the stored chain of {p.gex.session ?? MISSING}. Expiry-wise GEX is one expiry at a time (see the Gamma page).</Note>
        <div className="mt-2 grid grid-cols-2 gap-3 border-t border-rule pt-2 sm:grid-cols-4"><Kv k="Average CE vega" v={n(p.vega.ce_avg_vega, 3)} /><Kv k="Average PE vega" v={n(p.vega.pe_avg_vega, 3)} /><Kv k="Strikes used" v={String(p.vega.strikes)} /></div>
        <Note>{p.vega.note}</Note>
      </Block>
      <Block id="volatility" title="Volatility intelligence" link="/tools/volatility-skew">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Kv k="ATM IV" v={p.volatility.atm_iv == null ? MISSING : `${p.volatility.atm_iv.toFixed(2)}%`} /><Kv k="ATM IV change (15 min)" v={`${sg(p.volatility.iv_change_15m)} pts`} /><Kv k="HV (daily)" v={n(p.volatility.hv)} /><Kv k="RV (daily)" v={n(p.volatility.rv)} />
          <Kv k={p.volatility.india_vix_label ?? VIX_LABEL} v={`${n(p.volatility.india_vix)}${p.volatility.india_vix_as_of ? ` (${p.volatility.india_vix_as_of})` : ""}`} /><Kv k="IV Rank / Percentile (252d, VIX closes)" v={`${n(p.volatility.ivr_252 ?? null, 0)} / ${n(p.volatility.ivp_252 ?? null, 0)}`} />
          <Kv k="25Δ skew (put − call)" v={sg(p.volatility.skew_25d)} /><Kv k="10Δ skew" v={sg(p.volatility.skew_10d)} /><Kv k="Risk reversal 25Δ (call − put)" v={sg(p.volatility.risk_reversal_25d)} /><Kv k="25Δ butterfly" v={sg(p.volatility.butterfly_25d)} />
          <Kv k="Term slope /30d" v={`${sg(p.volatility.term_slope_30d)} (${p.volatility.term_shape ?? MISSING})`} /><Kv k="Expected move (1σ to expiry)" v={p.volatility.expected_move_1sd_pts == null ? MISSING : `±${p.volatility.expected_move_1sd_pts.toFixed(0)} pts`} />
        </div>
        {p.volatility.term.length > 0 && <p className="mt-2 text-muted">Term: {p.volatility.term.map((t) => `${t.expiry.slice(5)} ${t.days == null ? "?" : t.days.toFixed(1)}d ${n(t.atm_iv)}%`).join(" · ")}</p>}
        {p.volatility.interpretation && <p className="mt-1 text-paper">{Array.isArray(p.volatility.interpretation) ? p.volatility.interpretation.join(" ") : p.volatility.interpretation}</p>}
        <Note>{p.volatility.note} IV rank and percentile describe the level of VIX and are never used on their own for direction.</Note>
      </Block>
      <Block id="futures" title="Futures and order flow" link="/tools/future-flow">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Kv k="Contract" v={p.futures.contract ?? MISSING} /><Kv k="Futures / basis" v={`${n(p.futures.series?.future ?? null)} / ${sg(p.futures.series?.basis ?? null, 1)}`} /><Kv k="OI change" v={sg(p.futures.oi_change, 0)} /><Kv k="Volume" v={fmtInt(p.futures.volume)} />
          <Kv k="Buildup (15 min)" v={p.futures.buildup ?? MISSING} /><Kv k="Futures CVD (Proxy)" tip={CVD_TIP} v={p.futures.flow?.cvd_pct == null ? MISSING : `${sg(Number(p.futures.flow.cvd_pct), 1)}%`} /><Kv k="Classified share" v={p.futures.flow?.classified_share == null ? MISSING : `${(Number(p.futures.flow.classified_share) * 100).toFixed(0)}%`} />
          <Kv k="Depth imbalance" v={p.futures.flow?.depth_imbalance == null ? MISSING : sg(Number(p.futures.flow.depth_imbalance))} /><Kv k="VWAP" v={n(Number(p.futures.vwap?.vwap ?? NaN) || null)} /><Kv k="VWAP distance" v={p.futures.vwap?.distance_pct == null ? MISSING : `${sg(Number(p.futures.vwap.distance_pct), 3)}%`} /><Kv k="VWAP slope /15 min" v={p.futures.vwap?.slope_pts_per_15m == null ? MISSING : sg(Number(p.futures.vwap.slope_pts_per_15m), 1)} />
        </div>
        {p.futures.rolling && (
          <div className="mt-2 overflow-x-auto" data-testid="mi-rolling"><table className="w-full min-w-[30rem]"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal" title={CVD_TIP}>Rolling futures CVD (Proxy)</th><th className="py-1 text-right font-normal">CVD</th><th className="py-1 text-right font-normal">% of classified</th><th className="py-1 font-normal">State</th></tr></thead>
            <tbody>{Object.values(p.futures.rolling.windows).map((w) => <tr key={w.minutes} className="border-t border-rule/50"><td className="py-1 text-paper">last {w.minutes} min</td><td className={`num py-1 text-right ${(w.cvd ?? 0) >= 0 ? "text-up" : "text-down"}`}>{w.cvd == null ? MISSING : sg(w.cvd, 0)}</td><td className="num py-1 text-right">{w.cvd_pct == null ? MISSING : `${sg(w.cvd_pct, 1)}%`}</td><td className={`py-1 ${w.status === "ok" ? "text-muted" : "text-warn"}`}>{w.status === "ok" ? "ok (estimate)" : w.status}</td></tr>)}</tbody></table>
            <p className="mt-1 text-muted">CVD momentum (5-min rate less 15-min rate): {p.futures.rolling.momentum_per_min == null ? MISSING : `${sg(p.futures.rolling.momentum_per_min, 1)} per minute`}. Differences of the stored per-minute cumulative flow; a window that cannot be formed says why.</p></div>
        )}
        <Note>{p.futures.note} Not available today: {p.futures.unavailable.join("; ")}.</Note>
      </Block>
      <Block id="heavyweight" title="Heavyweight intelligence" link="/tools/future-flow">
        {p.heavyweight.stocks.length === 0 ? <p className="text-muted">No heavyweight flow is available yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[40rem]" data-testid="mi-heavy"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Stock</th><th className="py-1 text-right font-normal">Weight %</th><th className="py-1 text-right font-normal">Change %</th><th className="py-1 text-right font-normal">Rel. volume</th><th className="py-1 text-right font-normal" title={CVD_TIP}>CVD % (Proxy)</th><th className="py-1 text-right font-normal">Index pts %</th></tr></thead>
            <tbody>{p.heavyweight.stocks.map((s) => <tr key={s.symbol} className="border-t border-rule/50"><td className="py-1 text-paper">{s.symbol}</td><td className="num py-1 text-right">{n(s.weight)}</td><td className={`num py-1 text-right ${(s.change_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>{sg(s.change_pct)}</td><td className="num py-1 text-right">{n(s.relative_volume)}</td><td className={`num py-1 text-right ${(s.cvd_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>{sg(s.cvd_pct, 1)}</td><td className="num py-1 text-right">{sg(s.contribution, 3)}</td></tr>)}</tbody></table></div>
        )}
        {p.heavyweight.metrics && <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5"><Kv k="Weighted CVD score (Proxy)" tip={CVD_TIP} v={sg(p.heavyweight.metrics.weighted_cvd_score ?? null, 0)} /><Kv k="Positive / negative CVD" v={`${p.heavyweight.metrics.positive_cvd ?? MISSING} / ${p.heavyweight.metrics.negative_cvd ?? MISSING}`} /><Kv k="Aggregate points" v={`${sg(p.heavyweight.metrics.aggregate_points_pct ?? null, 3)}%`} /><Kv k="Weight advancing / declining" v={`${p.heavyweight.metrics.heavy_up_weight ?? MISSING} / ${p.heavyweight.metrics.heavy_down_weight ?? MISSING}`} /><Kv k="Index vs heavyweights" v={p.heavyweight.metrics.divergence ?? "agree"} /></div>}
        <Note>{p.heavyweight.note} Each stock's CVD is normalised before the index-weighted average, never added raw. Not available today: {p.heavyweight.unavailable.join("; ")}.</Note>
      </Block>
    </section>
  );
}
