import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { fmtInt, fmtTimeIST, MISSING } from "../lib/format";
import { chainGreeks } from "../lib/optionTools";
import { marketClockMs } from "../lib/session";
import { ivAtDelta, liveSmile, skewMeasures, skewWorkedExample, type SmileRow } from "../lib/skew";
import { METRICS } from "../lib/metricRegistry";
import { MethodologyPanel } from "./MethodologyPanel";
import { SmileComparePanel, toView } from "./SmileCompare";
import { TermStructureView } from "./TermStructureView";
import { useLiveSpot } from "../lib/useLive";
import { useDashOptional } from "./dashboard/DashContext";
import { EChart, useChartColors } from "./EChart";

const n2 = (v: number | null | undefined, unit = "") => (v == null ? MISSING : `${v.toFixed(2)}${unit}`);
const sgn = (v: number | null | undefined, unit = " pts") => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}${unit}`);
const VIEWS = ["Smile", "Term", "Table"] as const;

/** What a skew figure says, in words; the sign convention is stated and the thresholds are ours. */
export function skewReading(skew25: number | null): string {
  if (skew25 == null) return "No 25-delta put and call with a solved price: skew is not available.";
  if (Math.abs(skew25) < 0.5) return "Put and call wings are priced about the same (within 0.5 points): little skew.";
  return skew25 > 0
    ? `Puts are priced ${skew25.toFixed(2)} points above calls at 25 delta: downside protection costs more than upside (the usual shape).`
    : `Calls are priced ${Math.abs(skew25).toFixed(2)} points above puts at 25 delta: upside is priced richer than downside (unusual).`;
}

/** Volatility smile, skew measures and term view from the latest stored chain of the chosen expiry. */
export function IvSkewBody({ expiry }: { expiry: string | null }) {
  const c = useChartColors();
  const [view, setView] = useState<(typeof VIEWS)[number]>("Smile");
  const q = useQuery({ queryKey: ["ivSkew", expiry], queryFn: () => api.intradayIvSkew(expiry!), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  // comparison session: the previous stored session of the same expiry unless the user picks another or none
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const sessionList = q.data?.sessions ?? [];
  const prevDefault = sessionList.length >= 2 ? sessionList[sessionList.length - 2]! : null;
  const cmpSession = picked === undefined ? prevDefault : picked;
  const cmpQ = useQuery({ queryKey: ["ivSkew", expiry, cmpSession], queryFn: () => api.intradayIvSkew(expiry!, cmpSession!), enabled: !!expiry && !!cmpSession && view === "Smile", staleTime: 300_000, retry: false });
  // Live: while the stream is fresh the smile and every measure are recomputed from the option chain's live prices on each tick,
  // exactly as the old skew widget did. The stored chain (a sample a minute) is the source when the stream is not live, and it
  // always supplies the term view (other expiries).
  const dash = useDashOptional();
  const ls = useLiveSpot();
  const liveOn = !!dash && !!expiry && dash.expiry === expiry && dash.liveMode === "fresh" && ls.live && ls.ltp != null && !!dash.snapshot;
  const live = useMemo(() => {
    if (!liveOn || !dash || !expiry || ls.ltp == null) return null;
    const g = chainGreeks(dash.rows, ls.ltp, expiry, marketClockMs(Date.now()));
    const sm = liveSmile(g.strikes, g.forward, ls.ltp);
    if (g.forward == null || sm.rows.length === 0) return null;
    return { ...sm, forward: g.forward, spot: ls.ltp, at: Date.now(), metrics: skewMeasures(sm.rows, g.forward, sm.atmIv) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOn, dash?.rows, ls.ltp, expiry]);
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (!live && q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (!live && (q.isError || !q.data)) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The volatility skew could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const stored = q.data;
  if (!live && (!stored || stored.smile.length === 0 || !stored.cards)) return <p className="text-sm text-muted" data-testid="ivskew-empty">{stored?.status ?? "No stored chain"}.</p>;
  // one view model for both sources
  const s = {
    expiry, days: stored?.days ?? null, term: stored?.term ?? [], model: stored?.model ?? "Black-76; forward from put-call parity", rate_assumed: stored?.rate_assumed,
    smile: live ? live.rows.filter((r) => r.otm) : stored!.smile, atm_strike: live ? live.atmStrike : stored!.atm_strike, atm_iv: live ? live.atmIv : stored!.atm_iv,
    spot: live ? live.spot : stored!.spot, forward: live ? live.forward : stored!.forward,
    at: live ? new Date(live.at).toISOString() : stored!.at, age_seconds: live ? 0 : stored!.age_seconds,
  };
  const k = { ...(live ? live.metrics : stored!.cards!), term_slope_per_30d: stored?.cards?.term_slope_per_30d ?? null };
  const stale = !live && (s.age_seconds ?? 0) > 300;
  const tip = { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${v.toFixed(2)}%`) };
  // call and put curves on one strike axis, the spot and ATM lines, and the interpolated 25- and 10-delta points (diamonds, placed between their two strikes)
  const thenSmile = cmpSession && cmpQ.data?.status === "ok" ? cmpQ.data.smile : [];
  const strikeAxis = [...new Set([...s.smile, ...thenSmile].map((p) => p.strike))].sort((x, y) => x - y);
  const smileRows: SmileRow[] = s.smile.map((p): SmileRow => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta ?? null, otm: true }));
  const idx = (k: number) => strikeAxis.indexOf(k);
  const nearestIdx = (v: number) => strikeAxis.reduce((best, k, i) => (Math.abs(k - v) < Math.abs(strikeAxis[best]! - v) ? i : best), 0);
  const deltaPoints = ([["CE", 0.25, "25Δ call"], ["PE", 0.25, "25Δ put"], ["CE", 0.1, "10Δ call"], ["PE", 0.1, "10Δ put"]] as const).flatMap(([side, t, name]) => {
    const d = ivAtDelta(smileRows, side, t);
    if (!d || idx(d.lo.strike) < 0 || idx(d.hi.strike) < 0) return [];
    const frac = d.hi.delta === d.lo.delta ? 0 : (t - d.lo.delta) / (d.hi.delta - d.lo.delta);
    return [{ name, coord: [idx(d.lo.strike) + frac * (idx(d.hi.strike) - idx(d.lo.strike)), d.iv], value: d.iv.toFixed(2), itemStyle: { color: side === "CE" ? c.up : c.down } }];
  });
  // The ATM strike and the spot are usually a strike or two apart; two labels at the same height would print over each other, so close marks share one label.
  const atmAt = idx(s.atm_strike ?? NaN);
  const spotAt = s.spot != null ? nearestIdx(s.spot) : -1;
  const strikeMarks = spotAt >= 0 && atmAt >= 0 && Math.abs(spotAt - atmAt) <= 3
    ? [{ xAxis: spotAt, label: { formatter: "ATM · Spot", color: c.brass }, lineStyle: { color: c.brass, type: "solid" } }]
    : [{ xAxis: atmAt, label: { formatter: "ATM" } }, ...(spotAt >= 0 ? [{ xAxis: spotAt, label: { formatter: "Spot", color: c.brass }, lineStyle: { color: c.brass, type: "solid" } }] : [])];
  const smile = {
    grid: { left: 46, right: 14, top: 36, bottom: 28 }, tooltip: tip,
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    xAxis: { type: "category", data: strikeAxis.map(String), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
    series: [
      { name: "Call IV (OTM)", type: "line", showSymbol: true, symbolSize: 5, connectNulls: false, data: strikeAxis.map((k) => s.smile.find((p) => p.strike === k && p.side === "CE")?.iv ?? null), lineStyle: { color: c.up, width: 2 }, itemStyle: { color: c.up },
        markLine: { silent: true, symbol: "none", label: { color: c.muted, fontSize: 10, position: "end" }, lineStyle: { color: c.muted, type: "dashed" }, data: strikeMarks },
        markPoint: { symbol: "diamond", symbolSize: 11, label: { show: false }, data: deltaPoints } },
      { name: "Put IV (OTM)", type: "line", showSymbol: true, symbolSize: 5, connectNulls: false, data: strikeAxis.map((k) => s.smile.find((p) => p.strike === k && p.side === "PE")?.iv ?? null), lineStyle: { color: c.down, width: 2 }, itemStyle: { color: c.down } },
      ...(thenSmile.length ? [
        { name: `Call IV ${cmpSession}`, type: "line", showSymbol: false, connectNulls: false, data: strikeAxis.map((k) => thenSmile.find((p) => p.strike === k && p.side === "CE")?.iv ?? null), lineStyle: { color: c.up, width: 1.5, type: "dashed", opacity: 0.8 }, itemStyle: { color: c.up } },
        { name: `Put IV ${cmpSession}`, type: "line", showSymbol: false, connectNulls: false, data: strikeAxis.map((k) => thenSmile.find((p) => p.strike === k && p.side === "PE")?.iv ?? null), lineStyle: { color: c.down, width: 1.5, type: "dashed", opacity: 0.8 }, itemStyle: { color: c.down } },
      ] : []),
    ],
  };
  const card = (label: string, value: string, hint: string) => (
    <div key={label} title={hint}><div className="text-[11px] text-muted">{label}</div><div className="num text-lg font-semibold text-paper">{value}</div></div>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="ivskew-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">Expiry {s.expiry} · {s.days == null ? MISSING : s.days.toFixed(1)} days · NIFTY {fmtInt(s.spot ?? null)} · forward {fmtInt(s.forward ?? null)} · ATM strike {fmtInt(s.atm_strike ?? null)} · {live ? "live chain, updating with every tick" : "stored chain"} at {s.at ? fmtTimeIST(s.at) : MISSING} IST</div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="ivskew-stale">The newest stored chain is {Math.round((s.age_seconds ?? 0) / 60)} minutes old: the sampler may have stopped.</p>}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="ivskew-cards">
          {card("ATM IV", n2(s.atm_iv, "%"), "Average of the ATM call and put implied volatility")}
          {card("25Δ skew", sgn(k.skew_25d), "Put IV minus call IV at about 25 delta")}
          {card("25Δ butterfly", sgn(k.butterfly_25d), "Mean of the 25-delta wing IVs minus ATM IV")}
          {card("10Δ skew", sgn(k.skew_10d), "Put IV minus call IV at about 10 delta")}
          {card("Skew slope", sgn(k.slope_per_pct, " pts/%"), "IV points per 1% of moneyness, over the out-of-the-money options")}
          {card("25Δ call − put", sgn(k.call_minus_put_25d), "Call IV minus put IV at 25 delta: the same number as the skew with the opposite sign (negative: calls richer)")}
          {card("10Δ butterfly", sgn(k.butterfly_10d), "Mean of the 10-delta wing IVs minus ATM IV")}
          {card("25Δ call / put IV", `${n2(k.call_25d_iv)} / ${n2(k.put_25d_iv)}`, "Interpolated at 0.25 absolute delta")}
          {card("10Δ call / put IV", `${n2(k.call_10d_iv)} / ${n2(k.put_10d_iv)}`, "Interpolated at 0.10 absolute delta")}
          {card("Term slope", sgn(k.term_slope_per_30d, " pts/30d"), "ATM IV, farthest minus nearest stored expiry, per 30 days")}
        </div>
        <p className="mt-2 text-xs text-paper" data-testid="ivskew-reading">{skewReading(k.skew_25d)}</p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="mb-2 flex gap-1" role="tablist" aria-label="Skew view">
          {VIEWS.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={`min-h-9 rounded-sm border px-3 text-xs ${view === v ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>{v}</button>
          ))}
        </div>
        {view === "Smile" && (
          <>
            <div style={{ height: 320 }} data-testid="ivskew-smile"><EChart option={smile} ariaLabel="Implied volatility of the out-of-the-money option at each strike" /></div>
            <p className="mt-1 text-[11px] text-muted">Each strike shows its out-of-the-money option (puts below the ATM strike, calls above, the call at the ATM strike). A gap means that price was missing or no volatility could be solved; nothing is filled in.</p>
            <SmileComparePanel now={{ label: live ? "Live" : "Now", session: live ? null : (stored?.session ?? null), expiry: s.expiry, atmIv: s.atm_iv ?? null, at: s.at ?? null, smile: s.smile.map((p) => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta ?? null })) }}
              then={cmpSession && cmpQ.data?.status === "ok" ? toView(cmpQ.data, cmpSession) : null} sessions={sessionList} value={cmpSession ?? null} onChange={(v) => setPicked(v)}
              loading={!!cmpSession && cmpQ.isLoading} error={cmpQ.isError ? (cmpQ.error instanceof Error ? cmpQ.error.message : "error") : cmpQ.data && cmpQ.data.status !== "ok" ? cmpQ.data.status : null} />
          </>
        )}
        {view === "Term" && (s.term.length >= 2 ? (
          <>
            {stored && <TermStructureView d={stored} />}
            {stored?.term_structure && (
              <div className="mt-2 rounded-sm bg-slate-2 p-2 text-xs text-muted" data-testid="ivskew-term-structure">
                {stored.term_structure.shape && stored.term_structure.near && stored.term_structure.far ? (
                  <>
                    <div className="text-paper"><span className="font-semibold">{stored.term_structure.shape === "contango" ? "Contango" : stored.term_structure.shape === "backwardation" ? "Backwardation" : "Flat"}</span>: term slope {sgn(stored.term_structure.slope_per_30d, " pts/30d")} = ({n2(stored.term_structure.far.atm_iv)} − {n2(stored.term_structure.near.atm_iv)}) / ({stored.term_structure.far.days.toFixed(2)} − {stored.term_structure.near.days.toFixed(2)}) × 30, far {stored.term_structure.far.expiry}, near {stored.term_structure.near.expiry}.</div>
                    <div>{(stored.term_structure.iv_difference ?? 0) >= 0 ? "Longer-term volatility premium" : "Near-term volatility premium"}: {Math.abs(stored.term_structure.iv_difference ?? 0).toFixed(2)} IV points. Pairs: {stored.term_structure.pairs.map((q) => `${q.near.slice(5)}→${q.far.slice(5)} ${sgn(q.slope, "")}`).join("; ") || MISSING}.</div>
                  </>
                ) : <div>Fewer than two expiries with a solved IV and at least half a day left: no slope.</div>}
                {stored.term_structure.left_out.length > 0 && <div className="text-warn">Left out of the slope: {stored.term_structure.left_out.map((l) => `${l.expiry} (${l.reason})`).join("; ")}.</div>}
              </div>
            )}
            <p className="mt-1 text-[11px] text-muted">Expiries with a chain stored within 5 minutes of this one. Near expiries carry event and expiry-day effects, so a difference is an observation, not a signal.</p>
          </>
        ) : <p className="text-sm text-muted" data-testid="ivskew-term-empty">Only {s.term.length} expiry has a stored chain at this moment: a term view needs at least two.</p>)}
        {view === "Table" && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] max-w-[34rem] text-xs" data-testid="ivskew-table">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Strike</th><th className="py-1 font-normal">Option</th><th className="py-1 text-right font-normal">Delta</th><th className="py-1 text-right font-normal">IV</th></tr></thead>
              <tbody>
                {s.smile.map((p) => (
                  <tr key={`${p.strike}${p.side}`} className={`border-t border-rule/50 ${p.strike === s.atm_strike ? "bg-brass/10" : ""}`}>
                    <td className="num py-1 text-paper">{fmtInt(p.strike)}{p.strike === s.atm_strike ? " ATM" : ""}</td>
                    <td className="py-1 text-muted">{p.side === "CE" ? "Call" : "Put"}</td>
                    <td className="num py-1 text-right text-muted">{p.delta == null ? MISSING : p.delta.toFixed(2)}</td>
                    <td className="num py-1 text-right text-paper">{n2(p.iv, "%")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">{s.model}; assumed rate {s.rate_assumed == null ? MISSING : `${(s.rate_assumed * 100).toFixed(2)}%`}. Skew = put IV − call IV at the same delta; butterfly = mean of the wing IVs − ATM IV. These describe how options are priced, not where the index will go.</p>
        <MethodologyPanel metrics={[METRICS.iv_skew!, METRICS.iv_butterfly!, METRICS.iv_slope!, METRICS.term_slope!]}
          example={skewWorkedExample(s.smile.map((p): SmileRow => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta ?? null, otm: true })), s.atm_iv ?? null)}
          freshness={{ updatedAt: s.at ?? null, session: s.at ? s.at.slice(0, 10) : null, expiry: s.expiry, used: s.smile.filter((p) => p.iv != null).length, missing: s.smile.filter((p) => p.iv == null).length, timeframe: live ? "live stream, recomputed on each tick" : "latest stored chain" }} />
      </div>
    </div>
  );
}
