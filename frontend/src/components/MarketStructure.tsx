import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { fmtInt, MISSING } from "../lib/format";
import { fmtCrore, type StructurePoint } from "../lib/gammaAnalysis";
import { gexPriceDivergence, gexUniverses } from "../lib/gexIntel";
import { rankAt } from "../lib/ivChart";
import { METRICS } from "../lib/metricRegistry";
import { classifyRegime, type RegimeInputs, type RegimeResult } from "../lib/regime";
import { marketClockMs } from "../lib/session";
import { useDashOptional } from "./dashboard/DashContext";
import { MethodologyPanel } from "./MethodologyPanel";

const sg = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const f2 = (v: number | null | undefined, u = "") => (v == null ? MISSING : `${v.toFixed(2)}${u}`);
const last = (xs: (number | null)[]) => { for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return xs[i]!; return null; };

function Card({ label, value, sub, tone = "text-paper" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return <div className="rounded-sm bg-slate-2 p-2" data-testid="ms-card"><div className="text-[11px] text-muted">{label}</div><div className={`num text-base font-semibold ${tone}`}>{value}</div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>;
}
function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3"><h2 className="mb-2 text-sm font-semibold text-paper">{title}</h2>{children}</section>;
}

/** The central view: every figure is read from a section's own endpoint or library; the regime only combines them. */
export function MarketStructureBody({ expiry }: { expiry: string | null }) {
  const dash = useDashOptional();
  const on = { enabled: !!expiry, refetchInterval: 30_000, retry: false } as const;
  const skew = useQuery({ queryKey: ["ivSkew", expiry], queryFn: () => api.intradayIvSkew(expiry!), ...on });
  const mom = useQuery({ queryKey: ["ivMomentum", expiry, 1], queryFn: () => api.intradayIvMomentum(expiry!, 1), ...on });
  const pos = useQuery({ queryKey: ["strikePos", expiry, "15"], queryFn: () => api.intradayStrikePositioning(expiry!, "15"), ...on });
  // GEX inputs of the regime come from ONE universe (the dynamic ATM ±10 rebuild of the stored chains), the same series for the level, the
  // change, the flip, the near-ATM figure and the GEX-price relationship
  const gexh = useQuery({ queryKey: ["gexHistory", expiry, "dynamic"], queryFn: () => api.intradayGexHistory(expiry!, "dynamic"), ...on });
  const chart = useQuery({ queryKey: ["ivchart", 21], queryFn: () => api.intradayIvChart(21), refetchInterval: 300_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if ([skew, mom, pos, chart].every((q) => q.isLoading)) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;

  const sk = skew.data?.status === "ok" ? skew.data : null;
  const m15 = mom.data?.table?.periods["15"] ?? null;
  const mPrev = mom.data?.table?.previous_close ?? null;
  const p = pos.data?.status === "ok" ? pos.data : null;
  const ch = chart.data ?? null;
  const iv = ch ? last(ch.iv) : null, hv = ch ? last(ch.hv) : null, rv = ch ? last(ch.rv) : null;
  const rk = ch ? rankAt(ch.iv, Math.max(0, ch.iv.reduce<number>((a, v, k) => (v != null ? k : a), -1)), 252) : null;
  const gex = dash && dash.rows.length && dash.snapshot?.underlying_ltp != null ? (() => {
    const spot = dash.snapshot!.underlying_ltp!;
    return gexUniverses(dash.rows, spot, expiry, Date.parse(dash.snapshot!.retrieved_at) || marketClockMs(Date.now()), null, 10);
  })() : [];
  const full = gex.find((u) => u.id === "full"), dyn = gex.find((u) => u.id === "dynamic");
  const gh = gexh.data?.status === "ok" && Array.isArray(gexh.data.points) ? gexh.data.points : [];
  const ghPts: StructurePoint[] = gh.map((p) => ({ t: Date.parse(p.at), spot: p.spot, net: p.net, peak: p.peak, callWall: p.call_wall, putWall: p.put_wall, flip: p.flip, roc: null }));
  const div = ghPts.length >= 2 ? gexPriceDivergence(ghPts, 15) : null;
  const ghLast = gh[gh.length - 1] ?? null;
  const atmChg = m15 && m15.atm.ce_change != null && m15.atm.pe_change != null ? (m15.atm.ce_change + m15.atm.pe_change) / 2 : null;
  const demandMap: RegimeInputs["demand"] = p && p.demand.length ? Object.fromEntries(p.demand.map((x) => [`${x.side}:${x.group}`, x.label])) : null;
  const inputs: RegimeInputs = {
    spotPct: m15?.spot_change_pct ?? null, atmIvChange: atmChg, momentum25: m15?.d25.momentum ?? null,
    skew25: sk?.cards?.skew_25d ?? null, butterfly25: sk?.cards?.butterfly_25d ?? null, ivMinusHv: iv != null && hv != null ? iv - hv : null,
    demand: demandMap, netGex: ghLast?.net ?? null, flip: ghLast?.flip ?? null, spot: ghLast?.spot ?? dash?.snapshot?.underlying_ltp ?? sk?.spot ?? null,
    divergence: div?.kind ?? null, divergenceLabel: div?.label ?? null, gexNetChange: div?.netChange ?? null, gexNetPct: div?.netChangePct ?? null,
    universe: ghLast ? "dynamic ATM ±10 (rebuilt from stored chains)" : null, nearAtmNet: ghLast?.near_net ?? null,
  };
  const r: RegimeResult = classifyRegime(inputs);
  const warn: string[] = [];
  if (!sk) warn.push(`Volatility skew: ${skew.data?.status ?? "not loaded"}.`);
  if (!m15) warn.push("IV momentum: no stored snapshot 15 minutes earlier.");
  if (!p) warn.push(`Strike positioning: ${pos.data?.status ?? "not loaded"}.`);
  if (!ch) warn.push("IV, HV and RV history not loaded.");
  if (!dash || gex.length === 0) warn.push("GEX needs the option chain: open this page from the Options menu with a stored chain.");
  if ((skew.data?.age_seconds ?? 0) > 300) warn.push(`The newest stored chain is ${Math.round((skew.data?.age_seconds ?? 0) / 60)} minutes old.`);
  if (!ghLast) warn.push(`GEX history: ${gexh.data?.status ?? "not loaded"}; the GEX and GEX-price conditions are not evaluable.`);
  else if (!div || div.kind === "unavailable") warn.push(`GEX-price relationship: ${div?.label ?? "needs at least two rebuilt snapshots"}.`);
  const tone = r.regime.includes("Bullish") ? "text-up" : r.regime.includes("Bearish") ? "text-down" : r.regime.includes("Negative") || r.regime.includes("Uncertainty") ? "text-warn" : "text-paper";
  const example = [
    `Evaluable conditions: ${r.evidence.filter((e) => e.met !== null).length} of ${r.evidence.length}; bull met ${r.evidence.filter((e) => e.side === "bull" && e.met).length} of ${r.evidence.filter((e) => e.side === "bull" && e.met !== null).length}, bear met ${r.evidence.filter((e) => e.side === "bear" && e.met).length} of ${r.evidence.filter((e) => e.side === "bear" && e.met !== null).length}`,
    `Direction ${r.direction}; ATM IV change ${sg(inputs.atmIvChange)} pts → ${r.volatility}; net GEX ${fmtCrore(inputs.netGex)} → ${r.gamma} gamma`,
    `Regime: ${r.regime}; confidence ${r.confidence.level} (completeness ${(r.confidence.completeness * 100).toFixed(0)}%, agreement ${r.confidence.agreement == null ? MISSING : `${(r.confidence.agreement * 100).toFixed(0)}%`})`,
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="ms-tool">
      <Block title="Market regime (rule-based, last 15 minutes)">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><span className={`text-xl font-semibold ${tone}`} data-testid="ms-regime">{r.regime}</span>
          <span className="text-xs text-muted" data-testid="ms-confidence">Confidence {r.confidence.level}: evidence completeness {(r.confidence.completeness * 100).toFixed(0)}%, directional agreement {r.confidence.agreement == null ? MISSING : `${(r.confidence.agreement * 100).toFixed(0)}%`} (not a probability)</span></div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Card label="Directional bias" value={r.direction} /><Card label="Volatility condition" value={r.volatility} sub={`ATM IV ${sg(inputs.atmIvChange)} pts / 15 min`} />
          <Card label="Gamma condition" value={r.gamma} sub={`net GEX ${fmtCrore(inputs.netGex)} cr (dynamic ±10, model sign)`} />
          <Card label="Upside demand score" value={r.upsideScore == null ? MISSING : r.upsideScore} sub="share of upside conditions met (index)" /><Card label="Downside demand score" value={r.downsideScore == null ? MISSING : r.downsideScore} sub="share of downside conditions met (index)" />
          <Card label="Market stability score" value={r.stabilityScore == null ? MISSING : r.stabilityScore} sub="positive GEX, calm IV, flat NIFTY (index)" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="ms-gexview">
          <Card label="GEX universe" value={<span className="text-sm">{r.gexView.universe ?? MISSING}</span>} sub="used for every GEX figure here" />
          <Card label="NIFTY change (15 min)" value={`${sg(r.gexView.spotPct)}%`} />
          <Card label="Net GEX change" value={r.gexView.netChange == null ? MISSING : `${sg(r.gexView.netChange)} cr`} sub={`${sg(r.gexView.netPct, 1)}%`} />
          <Card label="Gamma regime" value={r.gexView.gammaRegime} sub="net GEX sign, model assumption" />
          <Card label="Flip distance" value={r.gexView.flipDistancePct == null ? MISSING : `${sg(r.gexView.flipDistancePct)}%`} sub={inputs.flip == null ? "no flip within ±8%" : `flip ${fmtInt(Math.round(inputs.flip))}`} />
          <Card label="Near-ATM net GEX" value={fmtCrore(r.gexView.nearAtmNet)} sub="ATM ±5, ₹ crore" />
        </div>
        <p className="mt-1 text-xs text-muted" data-testid="ms-relationship">GEX-price relationship: {r.gexView.relationship ?? MISSING} This is a description of two series, not guaranteed dealer hedging behaviour.</p>
        <div className="mt-2 grid gap-2 text-xs md:grid-cols-3">
          <div data-testid="ms-support"><div className="font-semibold text-paper">Supporting evidence</div><ul className="list-disc pl-5 text-muted">{r.supporting.length ? r.supporting.map((t) => <li key={t}>{t}</li>) : <li>none</li>}</ul></div>
          <div data-testid="ms-contra"><div className="font-semibold text-paper">Contradicting evidence</div><ul className="list-disc pl-5 text-muted">{r.contradicting.length ? r.contradicting.map((t) => <li key={t}>{t}</li>) : <li>none</li>}</ul></div>
          <div data-testid="ms-unavail"><div className="font-semibold text-paper">Not evaluable (missing input)</div><ul className="list-disc pl-5 text-muted">{r.unavailable.length ? r.unavailable.map((t) => <li key={t}>{t}</li>) : <li>none</li>}</ul></div>
        </div>
        <MethodologyPanel metrics={[METRICS.regime_classifier!]} example={example}
          freshness={{ updatedAt: mom.data?.latest_at ?? null, session: mom.data?.session ?? null, expiry, used: r.evidence.filter((e) => e.met !== null).length, missing: r.unavailable.length, timeframe: "15-minute comparison; skew and positioning from the newest stored chain" }} />
      </Block>
      <Block title="A. Market snapshot">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Card label="NIFTY" value={fmtInt(inputs.spot)} sub={`${sg(mPrev?.spot_change_pct)}% vs previous close`} /><Card label="ATM IV (this expiry)" value={f2(sk?.atm_iv, "%")} />
          <Card label="India VIX" value={f2(iv, "%")} sub="30-day index, not this expiry" /><Card label="HV 1M" value={f2(hv, "%")} /><Card label="RV 1M" value={f2(rv, "%")} />
          <Card label="IV Rank / Percentile (1Y)" value={`${rk?.ivr == null ? MISSING : rk.ivr.toFixed(0)} / ${rk?.ivp == null ? MISSING : rk.ivp.toFixed(0)}`} />
          <Card label="Net GEX (full chain)" value={fmtCrore(full?.levels.netTotal)} sub="₹ crore / 1%" tone={(full?.levels.netTotal ?? 0) >= 0 ? "text-up" : "text-down"} /><Card label="Gamma flip (dynamic)" value={dyn?.levels.flip == null ? MISSING : fmtInt(Math.round(dyn.levels.flip))} />
        </div>
      </Block>
      <Block title="B. Volatility intelligence">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Card label="25Δ skew (put − call)" value={sg(sk?.cards?.skew_25d)} /><Card label="10Δ skew" value={sg(sk?.cards?.skew_10d)} /><Card label="25Δ butterfly" value={sg(sk?.cards?.butterfly_25d)} /><Card label="10Δ butterfly" value={sg(sk?.cards?.butterfly_10d)} />
          <Card label="Skew slope /1%" value={sg(sk?.cards?.slope_per_pct, 3)} /><Card label="Term slope /30d" value={sg(sk?.cards?.term_slope_per_30d)} sub={sk?.term_structure?.shape ?? undefined} />
          <Card label="25Δ IV momentum (15 min)" value={sg(m15?.d25.momentum)} /><Card label="ATM IV momentum (15 min)" value={sg(m15?.atm.momentum)} /><Card label="IV − HV 1M" value={sg(inputs.ivMinusHv)} /><Card label="IV − RV 1M" value={iv != null && rv != null ? sg(iv - rv) : MISSING} />
        </div>
      </Block>
      <Block title="C. Options positioning (15 minutes)">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="ms-demand">
          {(p?.demand ?? []).map((x) => <Card key={`${x.side}${x.group}`} label={`${x.side === "CE" ? "Calls" : "Puts"} · ${x.group === "deep" ? "deep OTM" : "OTM"}`} value={<span className="text-sm">{x.label}</span>} sub={`OI ${sg(x.summary.oi_pct, 1)}% · premium ${sg(x.summary.premium_pct, 1)}% · IV ${sg(x.summary.iv_change)} pts`} />)}
          {!p?.demand.length && <p className="text-sm text-muted">No positioning comparison available.</p>}
        </div>
      </Block>
      <Block title="D. Gamma intelligence">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {(["full", "dynamic"] as const).map((id) => { const u = gex.find((g) => g.id === id); return (
            <Card key={id} label={`${id === "full" ? "Full chain" : "Dynamic ±10"}: net / absolute`} value={`${fmtCrore(u?.levels.netTotal)} / ${fmtCrore(u?.levels.absTotal)}`} sub={`flip ${u?.levels.flip == null ? MISSING : fmtInt(Math.round(u.levels.flip))} · walls ${u?.levels.putWall ?? MISSING}/${u?.levels.callWall ?? MISSING} · peak ${u?.levels.peak ?? MISSING}`} />
          ); })}
        </div>
      </Block>
      <Block title="E. Market interpretation and data quality">
        <p className="text-sm text-paper" data-testid="ms-interpretation">{r.regime === "Insufficient data" ? "Too few inputs are available to describe the market." : `Bias ${r.direction}, volatility ${r.volatility}, gamma ${r.gamma}: ${r.regime}.`} This describes what the indicators show; it is not a forecast or a trade signal.</p>
        <ul className="mt-2 list-disc pl-5 text-xs text-warn" data-testid="ms-warnings">{warn.map((w) => <li key={w}>{w}</li>)}</ul>
      </Block>
    </div>
  );
}
