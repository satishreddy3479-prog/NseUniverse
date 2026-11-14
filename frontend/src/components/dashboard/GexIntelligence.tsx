import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtCrore, gexSamples, gexStructure, type GexRow } from "../../lib/gammaAnalysis";
import { flipTime, gexDynamics, gexPriceDivergence, gexUniverses, migration, scenarioNet, SIGN_SCENARIOS, type Migrating, type Universe, type UniverseId } from "../../lib/gexIntel";
import { fmtInt, MISSING } from "../../lib/format";
import { METRICS } from "../../lib/metricRegistry";
import { strikesAround } from "../../lib/optionTools";
import { sessionOpenMin } from "../../lib/session";
import type { OptionChainRow } from "../../lib/types";
import { candles } from "../../lib/vegaAnalysis";
import { EChart, useChartColors } from "../EChart";
import { useClipped } from "./ReplayContext";
import { MethodologyPanel } from "../MethodologyPanel";
import { useSessionWindow } from "./PriceBoards";
import { Section } from "./VegaAnalysis";

const pill = (on: boolean) => `widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const lvl = (v: number | null | undefined) => (v == null ? MISSING : fmtInt(Math.round(v)));
const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const TFS = [1, 3, 5, 15] as const;
const WINDOWS: [string, number | null][] = [["5 min", 5], ["15 min", 15], ["30 min", 30], ["1 hour", 60], ["Full session", null]];
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/** Worked example: the call GEX of the strike with the largest absolute exposure, from its own gamma and OI. */
export function gexExample(p: Universe | undefined): string[] {
  if (!p) return [];
  const r: GexRow | undefined = [...p.profile.rows].filter((x) => x.ce != null && x.ceGamma != null && x.ceOi != null).sort((a, b) => (b.abs ?? 0) - (a.abs ?? 0))[0];
  if (!r) return [];
  const s = p.profile.spot;
  return [
    `Strike ${r.strike} call: gamma ${r.ceGamma!.toFixed(6)} × OI ${fmtInt(r.ceOi!)} units × spot² (${s.toFixed(1)}²) × 0.01 / 10⁷`,
    `= ${r.ceGamma!.toFixed(6)} × ${r.ceOi} × ${(s * s).toFixed(0)} × 0.01 / 10,000,000 = ${r.ce!.toFixed(2)} ₹ crore`,
    r.pe != null && r.peGamma != null && r.peOi != null ? `Strike ${r.strike} put: gamma ${r.peGamma.toFixed(6)} × OI ${fmtInt(r.peOi)} … = ${Math.abs(r.pe).toFixed(2)} ₹ crore, shown as ${sg(r.pe, 2)} (put sign); net = ${sg(r.net, 2)}` : `Strike ${r.strike} put: no usable price, volatility or OI: excluded`,
    `${p.label}: ${p.used} of ${p.listed} strikes used, ${p.excluded} excluded; aggregate net = ${fmtCrore(p.levels.netTotal)} ₹ crore`,
  ];
}

export function GexUniversesSection({ rows, spot, expiry, atMs, openAtm }: { rows: OptionChainRow[]; spot: number; expiry: string; atMs: number; openAtm: number | null }) {
  const [pick, setPick] = useState<UniverseId>("full");
  const us = useMemo(() => gexUniverses(rows, spot, expiry, atMs, openAtm, 10), [rows, spot, expiry, atMs, openAtm]);
  const cur = us.find((u) => u.id === pick) ?? us[us.length - 1];
  const sum = (u: Universe, side: "ce" | "pe") => u.profile.rows.reduce((a, r) => a + (r[side] ?? 0), 0);
  const th = "px-2 py-1.5 text-right font-normal";
  return (
    <Section title="GEX universes: fixed opening, dynamic current, full chain" right={<span className="text-xs text-muted">same calculation, three sets of strikes; never combined</span>}>
      <div className="overflow-x-auto p-2">
        <table className="num w-full min-w-[56rem] text-xs" data-testid="gex-universes">
          <thead><tr className="text-[11px] text-muted"><th className="px-2 py-1.5 text-left font-normal">Universe</th><th className={th}>Strikes used / listed</th><th className={th}>Excluded</th><th className={th}>CE GEX</th><th className={th}>PE GEX</th><th className={th}>Net GEX</th><th className={th}>Absolute GEX</th><th className={th}>Flip (vs spot)</th><th className={th}>Call wall</th><th className={th}>Put wall</th><th className={th}>Peak</th></tr></thead>
          <tbody>
            {us.map((u) => (
              <tr key={u.id} className={`border-t border-rule/50 ${u.id === pick ? "bg-brass/10" : ""}`} data-testid={`gex-universe-${u.id}`}>
                <td className="px-2 py-1.5 text-left"><button type="button" aria-pressed={u.id === pick} onClick={() => setPick(u.id)} className="text-left text-paper underline-offset-2 hover:underline">{u.label}</button></td>
                <td className="px-2 py-1.5 text-right">{u.used} / {u.listed}</td><td className="px-2 py-1.5 text-right text-muted">{u.excluded}</td>
                <td className="px-2 py-1.5 text-right text-up">{fmtCrore(sum(u, "ce"))}</td><td className="px-2 py-1.5 text-right text-down">{fmtCrore(sum(u, "pe"))}</td>
                <td className={`px-2 py-1.5 text-right ${(u.levels.netTotal ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtCrore(u.levels.netTotal)}</td><td className="px-2 py-1.5 text-right">{fmtCrore(u.levels.absTotal)}</td>
                <td className="px-2 py-1.5 text-right">{u.levels.flip == null ? "none within ±8%" : `${lvl(u.levels.flip)} (${sg(u.levels.flip - spot, 0)}, ${sg(((u.levels.flip - spot) / spot) * 100, 2)}%)`}</td>
                <td className="px-2 py-1.5 text-right">{lvl(u.levels.callWall)}</td><td className="px-2 py-1.5 text-right">{lvl(u.levels.putWall)}</td><td className="px-2 py-1.5 text-right">{lvl(u.levels.peak)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {openAtm == null && <p className="px-2 pt-1 text-[11px] text-warn" data-testid="gex-no-fixed">The fixed opening universe needs the session's first stored snapshot; none was found, so it is not shown.</p>}
        <h3 className="mt-3 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Sign-convention sensitivity ({cur?.label})</h3>
        <table className="num mt-1 w-full max-w-[34rem] text-xs" data-testid="gex-scenarios">
          <tbody>
            {cur && SIGN_SCENARIOS.map((s) => { const v = scenarioNet(cur.profile, s); return (
              <tr key={s.id} className="border-t border-rule/50"><td className="px-2 py-1 text-left text-muted">{s.label}</td><td className={`px-2 py-1 text-right ${v == null ? "" : v >= 0 ? "text-up" : "text-down"}`}>{fmtCrore(v)} cr</td><td className="px-2 py-1 text-right text-[11px] text-muted">{v == null ? MISSING : v >= 0 ? "stabilising" : "amplifying"}</td></tr>
            ); })}
          </tbody>
        </table>
        <p className="px-2 pt-1 text-[11px] text-muted">The default row is the model assumption; the others show how much the reading depends on it. None is observed dealer inventory.</p>
        <MethodologyPanel metrics={[METRICS.gex_core!, METRICS.gex_universes!, METRICS.gex_sign_scenarios!]} example={gexExample(cur)}
          freshness={{ updatedAt: new Date(atMs).toISOString(), session: new Date(atMs + 330 * 60_000).toISOString().slice(0, 10), expiry, used: cur?.used ?? null, missing: cur?.excluded ?? null, timeframe: "snapshot (stored or live chain)" }} />
      </div>
    </Section>
  );
}

export function GexSessionIntel({ expiry, listed, openAtm, curAtm, rate }: { expiry: string; listed: number[]; openAtm: number | null; curAtm: number | null; rate?: number }) {
  const c = useChartColors();
  const w = useSessionWindow();
  const [uni, setUni] = useState<"fixed" | "dynamic">("fixed");
  const [tf, setTf] = useState<(typeof TFS)[number]>(5);
  const centre = uni === "fixed" ? openAtm : (curAtm ?? openAtm);
  const key = useMemo(() => (centre == null ? "" : strikesAround(listed, centre, uni === "fixed" ? 21 : 41).join(",")), [listed, centre, uni]);
  const q = useQuery({
    queryKey: ["gexIntel", expiry, uni, key, w.since, w.until],
    queryFn: () => api.strikeSeries(expiry, key, w.since, w.until),
    enabled: !!w.since && !!key, refetchInterval: w.until ? false : 30_000, retry: false, placeholderData: keepPreviousData,
  });
  const qd = useClipped(q.data); // during a replay: only what was stored up to the replay time
  const pts = useMemo(() => {
    if (!qd) return [];
    const s = gexSamples(qd, expiry, rate, uni === "dynamic" ? 10 : undefined).filter((x) => !w.day || x.day === w.day);
    return gexStructure(candles(s, tf, sessionOpenMin()));
  }, [qd, expiry, uni, tf, w.day, rate]);
  const dyn = useMemo(() => gexDynamics(pts), [pts]);
  const ft = useMemo(() => flipTime(pts), [pts]);
  const five = useMemo(() => gexStructure(candles(qd ? gexSamples(qd, expiry, rate, uni === "dynamic" ? 10 : undefined).filter((x) => !w.day || x.day === w.day) : [], 5, sessionOpenMin())), [qd, expiry, uni, w.day, rate]);
  const div = useMemo(() => WINDOWS.map(([label, m]) => [label, gexPriceDivergence(five, m)] as const), [five]);
  const th = "px-2 py-1.5 text-right font-normal";
  const btn = (on: boolean) => pill(on);
  const mig = (k: Migrating, label: string) => { const m = migration(pts, k); return (
    <tr key={k} className="border-t border-rule/50"><td className="px-2 py-1 text-left text-muted">{label}</td><td className="px-2 py-1 text-right">{lvl(m.first)}</td><td className="px-2 py-1 text-right">{lvl(m.last)}</td><td className="px-2 py-1 text-right">{sg(m.change, 0)}</td><td className="px-2 py-1 text-right">{lvl(m.min)} – {lvl(m.max)}</td><td className="px-2 py-1 text-right">{m.moves}</td><td className="px-2 py-1 text-right text-muted">{m.n}</td></tr>
  ); };
  const opt = useMemo(() => pts.length < 2 ? null : {
    animation: false, grid: { left: 60, right: 60, top: 36, bottom: 30 },
    legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: pts.map((p) => hhmm(p.t)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [{ type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } }, { type: "value", position: "right", axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { show: false } }],
    series: [
      { name: "NIFTY", type: "line", showSymbol: false, data: pts.map((p) => p.spot), lineStyle: { color: c.brass, width: 2 } },
      { name: "Gamma flip", type: "line", showSymbol: false, connectNulls: false, data: pts.map((p) => p.flip), lineStyle: { color: c.info, width: 1.2, type: "dashed" } },
      { name: "Call wall", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.callWall), lineStyle: { color: c.down, width: 1, type: "dotted" } },
      { name: "Put wall", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.putWall), lineStyle: { color: c.up, width: 1, type: "dotted" } },
      { name: "Peak gamma", type: "line", showSymbol: false, step: "end", data: pts.map((p) => p.peak), lineStyle: { color: c.muted, width: 1, type: "dotted" } },
      { name: `Net GEX (${uni})`, type: "bar", yAxisIndex: 1, barMaxWidth: 8, data: pts.map((p) => ({ value: p.net, itemStyle: { color: (p.net ?? 0) >= 0 ? c.up : c.down, opacity: 0.45 } })) },
    ],
  }, [pts, c, uni]);
  const dynExample = pts.length >= 2 ? [
    `${uni === "fixed" ? "Fixed opening" : "Dynamic"} universe, ${tf}-minute candles: ${hhmm(pts[pts.length - 2]!.t)} net ${fmtCrore(pts[pts.length - 2]!.net)} → ${hhmm(pts[pts.length - 1]!.t)} net ${fmtCrore(pts[pts.length - 1]!.net)} cr`,
    `change = ${sg(dyn.netChange, 2)} cr; % = ${sg(dyn.netChange)} / |${fmtCrore(pts[pts.length - 2]!.net)}| × 100 = ${sg(dyn.netChangePct, 2)}%`,
  ] : [];
  const d1 = div.find(([l]) => l === "1 hour")?.[1];
  const divExample = d1 && d1.kind !== "unavailable" ? [
    `Window 1 hour: NIFTY ${fmtInt(five[five.length - 1]!.spot - (d1.spotChange ?? 0))} → ${fmtInt(five[five.length - 1]!.spot)}: ${sg(d1.spotChange, 1)} points (${sg(d1.spotChangePct, 3)}%)`,
    `Net GEX ${fmtCrore(d1.netThen)} → ${fmtCrore(d1.netNow)}: ${sg(d1.netChange, 2)} cr (${sg(d1.netChangePct, 1)}%)`, `Reading: ${d1.label}`,
  ] : [];
  const fresh = { updatedAt: pts.length ? new Date(pts[pts.length - 1]!.t).toISOString() : null, session: w.day ?? null, expiry, used: pts.length, missing: qd ? Math.max(0, qd.times.length - pts.length) : null, timeframe: `${tf}-minute candles (${uni} universe); divergence on 5-minute candles` };
  return (
    <>
      <Section title="Intraday GEX: movement, migration and time around the flip" right={<span className="text-xs text-muted">{pts.length} candles · session {w.day ?? MISSING}</span>}>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2 text-xs text-muted">
          <div role="group" aria-label="GEX universe" className="flex gap-1">{([["fixed", "Fixed opening ATM ±10"], ["dynamic", "Dynamic ATM ±10"]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={uni === k} onClick={() => setUni(k)} className={btn(uni === k)}>{l}</button>)}</div>
          <div role="group" aria-label="Candle" className="flex gap-1">{TFS.map((t) => <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)} className={btn(tf === t)}>{t}m</button>)}</div>
          {w.controls}
        </div>
        <div className="p-2">
          {q.isPending && !!key ? <p className="p-3 text-sm text-muted">Loading stored samples…</p>
            : key === "" ? <p className="p-3 text-sm text-muted" data-testid="gexintel-nokey">{uni === "fixed" ? "No opening snapshot found for this session: the fixed universe cannot be built." : "No ATM strike to centre the dynamic universe on."}</p>
            : opt ? (
              <>
                <div style={{ height: 320 }} data-testid="gexintel-chart"><EChart option={opt} ariaLabel="NIFTY, gamma flip, walls, peak gamma and net GEX through the session" /></div>
                <div className="grid gap-3 p-2 sm:grid-cols-2 lg:grid-cols-4 text-xs" data-testid="gexintel-cards">
                  {[["Net GEX change", `${sg(dyn.netChange, 2)} cr (${sg(dyn.netChangePct, 1)}%)`], ["Acceleration", dyn.acceleration == null ? MISSING : `${sg(dyn.acceleration, 3)} cr/min per candle`], ["Persistence", dyn.persistence.direction ? `${dyn.persistence.run} candle${dyn.persistence.run === 1 ? "" : "s"} ${dyn.persistence.direction}${dyn.persistence.share != null ? ` · ${Math.round(dyn.persistence.share * 100)}% of last moves` : ""}` : MISSING], ["Flip / call wall / put wall move", `${sg(dyn.flipMove, 0)} / ${sg(dyn.callWallMove, 0)} / ${sg(dyn.putWallMove, 0)} pts`], ["Time above flip", `${ft.above.toFixed(0)} min`], ["Time below flip", `${ft.below.toFixed(0)} min`], ["Flip crossings", String(ft.crossings)], ["No flip in range", `${ft.unknown.toFixed(0)} min`]].map(([l, v]) => <div key={l} className="rounded-sm bg-slate-2 p-2"><div className="text-[11px] text-muted">{l}</div><div className="num text-paper">{v}</div></div>)}
                </div>
                <div className="overflow-x-auto"><table className="num w-full min-w-[34rem] text-xs" data-testid="gexintel-migration">
                  <thead><tr className="text-[11px] text-muted"><th className="px-2 py-1.5 text-left font-normal">Level</th><th className={th}>First</th><th className={th}>Last</th><th className={th}>Change</th><th className={th}>Range</th><th className={th}>Moves</th><th className={th}>Candles</th></tr></thead>
                  <tbody>{mig("flip", "Gamma flip")}{mig("callWall", "Call wall")}{mig("putWall", "Put wall")}{mig("peak", "Peak gamma")}</tbody>
                </table></div>
              </>
            ) : <p className="p-3 text-sm text-muted" data-testid="gexintel-empty">Not enough stored samples with prices and open interest ({pts.length} usable).</p>}
          <p className="px-2 pt-1 text-[11px] text-muted">Showing the {uni === "fixed" ? "fixed opening" : "dynamic"} universe only; switch to see the other. They are not merged.</p>
          <MethodologyPanel metrics={[METRICS.gex_dynamics!]} example={dynExample} freshness={fresh} />
        </div>
      </Section>
      <Section title="GEX-price divergence" right={<span className="text-xs text-muted">{uni} universe · 5-minute candles</span>}>
        <div className="overflow-x-auto p-2">
          <table className="num w-full min-w-[46rem] text-xs" data-testid="gexdiv-table">
            <thead><tr className="text-[11px] text-muted"><th className="px-2 py-1.5 text-left font-normal">Window</th><th className={th}>NIFTY change</th><th className={th}>Net GEX then → now</th><th className={th}>Net GEX change</th><th className="px-2 py-1.5 text-left font-normal">Reading</th></tr></thead>
            <tbody>
              {div.map(([label, d]) => (
                <tr key={label} className="border-t border-rule/50" data-testid="gexdiv-row">
                  <td className="px-2 py-1.5 text-left text-muted">{label}</td>
                  <td className="px-2 py-1.5 text-right">{d.spotChange == null ? MISSING : `${sg(d.spotChange, 1)} (${sg(d.spotChangePct, 2)}%)`}</td>
                  <td className="px-2 py-1.5 text-right">{d.netThen == null ? MISSING : `${fmtCrore(d.netThen)} → ${fmtCrore(d.netNow)}`}</td>
                  <td className={`px-2 py-1.5 text-right ${d.netChange == null ? "" : d.netChange >= 0 ? "text-up" : "text-down"}`}>{d.netChange == null ? MISSING : `${sg(d.netChange, 2)} (${sg(d.netChangePct, 1)}%)`}</td>
                  <td className={`px-2 py-1.5 text-left ${d.kind === "amplifying" ? "text-warn" : d.kind === "stabilising" ? "text-info" : "text-muted"}`}>{d.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <MethodologyPanel metrics={[METRICS.gex_divergence!]} example={divExample} freshness={fresh} />
        </div>
      </Section>
    </>
  );
}
