import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fmtInt, fmtPct, MISSING } from "../../lib/format";
import { maxPain } from "../../lib/analytics";
import { strikesAround } from "../../lib/optionTools";
import { sessionOpenMin } from "../../lib/session";
import {
  corridor, fmtCrore, gammaDensity, gexLevels, gexProfile, gexSamples, gexStructure, IMPLICATION, regimeFor, strikeType,
  type GexRow,
} from "../../lib/gammaAnalysis";
import { candles } from "../../lib/vegaAnalysis";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { MethodologyPanel } from "../MethodologyPanel";
import { METRICS } from "../../lib/metricRegistry";
import { GexSessionIntel, GexUniversesSection } from "./GexIntelligence";
import { useDash } from "./DashContext";
import { useClipped } from "./ReplayContext";
import { useSessionWindow } from "./PriceBoards";
import { Card, Section } from "./VegaAnalysis";

const RANGES = [5, 10, 15, 20];
const TFS = [1, 3, 5, 15];
const pill = (on: boolean) => `widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const field = "widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const lvl = (v: number | null | undefined) => (v == null ? MISSING : fmtInt(Math.round(v)));
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/** Gamma exposure of the chain now, its smoothed concentration, and its structure through the session, from stored data only. */
export function GammaAnalysisBoard() {
  const d = useDash();
  const c = useChartColors();
  const w = useSessionWindow();
  const [range, setRange] = useState(10);
  const [type, setType] = useState<"combined" | "ce" | "pe">("combined");
  const [levelsOn, setLevelsOn] = useState(true);
  const [absOn, setAbsOn] = useState(true);
  const [extra, setExtra] = useState(false);
  const [tf, setTf] = useState(5);

  const spot = d.snapshot?.underlying_ltp ?? null;
  const atMs = d.snapshot ? Date.parse(d.snapshot.retrieved_at) : 0;
  const profile = useMemo(() => (spot != null && d.expiry && d.rows.length ? gexProfile(d.rows, spot, d.expiry, atMs) : null), [d.rows, spot, d.expiry, atMs]);
  const lv = useMemo(() => (profile ? gexLevels(profile) : null), [profile]);
  const pain = useMemo(() => maxPain(d.rows)?.strike ?? null, [d.rows]);
  const regime = lv ? regimeFor(lv) : null;
  const cor = lv ? corridor(lv.spot, [lv.putWall, lv.callWall, lv.peak, lv.flip, pain]) : null;
  const visible = useMemo(() => {
    if (!profile || !lv || lv.atmStrike == null) return [] as GexRow[];
    const i = profile.rows.findIndex((r) => r.strike === lv.atmStrike);
    return profile.rows.slice(Math.max(0, i - range), i + range + 1);
  }, [profile, lv, range]);
  const density = useMemo(() => (profile ? gammaDensity(profile.rows, extra ? 2 : 1) : null), [profile, extra]);

  // ---- through the session: 21 strikes around the open ATM
  const all = d.history.data?.observations;
  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((a, b) => a - b), [d.rows]);
  const openAtm = useMemo(() => (all && w.since ? (all.find((o) => o.retrieved_at === w.since)?.atm_strike ?? null) : null), [all, w.since]);
  const key = useMemo(() => (openAtm == null ? "" : strikesAround(listed, openAtm, 21).join(",")), [listed, openAtm]);
  const q = useQuery({
    queryKey: ["gexDay", d.expiry, key, w.since, w.until],
    queryFn: () => api.strikeSeries(d.expiry!, key, w.since, w.until),
    enabled: !!d.expiry && !!w.since && !!key, refetchInterval: w.until ? false : 30_000, retry: false,
  });
  const qd = useClipped(q.data); // during a replay: only what was stored up to the replay time
  const structure = useMemo(() => {
    if (!qd || !d.expiry) return [];
    const s = gexSamples(qd, d.expiry).filter((x) => !w.day || x.day === w.day);
    return gexStructure(candles(s, tf, sessionOpenMin()));
  }, [qd, d.expiry, w.day, tf]);

  // ---- chart options
  const posOf = (strikes: number[], x: number) => {
    if (strikes.length < 2) return 0;
    if (x <= strikes[0]!) return 0;
    for (let i = 1; i < strikes.length; i++) if (x <= strikes[i]!) return i - 1 + (x - strikes[i - 1]!) / (strikes[i]! - strikes[i - 1]!);
    return strikes.length - 1;
  };
  const profileOpt = useMemo(() => {
    if (!lv || visible.length === 0) return null;
    const strikes = visible.map((r) => r.strike);
    const pick = (r: GexRow) => (type === "ce" ? r.ce : type === "pe" ? r.pe : r.net);
    // level labels sit horizontally at the top, staggered over four rows so close levels (wall, flip, peak, spot) never overlap
    const defs: [string, number | null, string, string][] = [["Spot", lv.spot, c.brass, "solid"], ["Call wall", lv.callWall, c.down, "dashed"], ["Put wall", lv.putWall, c.up, "dashed"], ["Peak", lv.peak, c.info, "dotted"], ["Flip", lv.flip, c.muted, "dotted"]];
    const levelMarks = !levelsOn ? [] : defs.filter((x): x is [string, number, string, string] => x[1] != null).sort((p, q) => p[1] - q[1]).map(([name, x, color, dash], k) => ({
      name, xAxis: posOf(strikes, x), lineStyle: { color, type: dash, width: 1.4 },
      label: { formatter: `${name} ${fmtInt(Math.round(x))}`, color, fontSize: 10, position: "end", rotate: 0, align: "center", offset: [0, -13 * (k % 4)] },
    }));
    return {
      animation: false, grid: { left: 62, right: 30, top: 84, bottom: 56 },
      legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${fmtCrore(v)} cr`) },
      xAxis: { type: "category", data: strikes.map(String), axisLabel: { color: c.muted, fontSize: 10, rotate: 45, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
      yAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
      dataZoom: [{ type: "inside", filterMode: "none" }],
      series: [
        {
          name: type === "combined" ? "Net GEX" : type === "ce" ? "Call GEX" : "Put GEX", type: "bar", barMaxWidth: 22,
          data: visible.map((r) => ({ value: pick(r), itemStyle: { color: (pick(r) ?? 0) >= 0 ? c.info : c.down } })),
          markLine: { symbol: "none", silent: true, data: levelMarks },
        },
        ...(absOn && type === "combined" ? [{ name: "Absolute GEX", type: "line", smooth: false, showSymbol: true, symbolSize: 4, data: visible.map((r) => r.abs), lineStyle: { color: c.info, width: 1.2, opacity: 0.8 }, itemStyle: { color: c.info } }] : []),
      ],
    };
  }, [lv, visible, type, levelsOn, absOn, c]);
  const densityOpt = useMemo(() => {
    if (!density || !lv) return null;
    const line = (name: string, color: string, data: number[], dotted = false) => ({ name, type: "line", showSymbol: false, smooth: true, data: density.xs.map((x, i) => [x, data[i]]), lineStyle: { color, width: 2, type: dotted ? "dotted" : "solid" }, itemStyle: { color } });
    // horizontal labels staggered over rows so close peaks never overlap
    let row = 0;
    const vline = (name: string, x: number | null, color: string) => (x == null ? [] : [{ name, xAxis: x, lineStyle: { color, width: 1.2 }, label: { formatter: `${name} ${fmtInt(Math.round(x))}`, color, fontSize: 10, position: "end", rotate: 0, align: "center", offset: [0, -13 * (row++ % 4)] } }]);
    return {
      animation: false, grid: { left: 62, right: 30, top: 84, bottom: 40 },
      legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number) => `${fmtCrore(v)} cr` },
      xAxis: { type: "value", scale: true, axisLabel: { color: c.muted, formatter: (v: number) => fmtInt(Math.round(v)) }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: false } },
      yAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
      series: [
        { ...line("Sell gamma (calls)", c.down, density.sell), markLine: { symbol: "none", silent: true, data: [...vline("Sell peak", density.sellPeak, c.down), ...vline("Buy peak", density.buyPeak, c.up), ...vline("Total peak", density.neutralPeak, c.brass), ...vline("Spot", lv.spot, c.muted)] } },
        line("Buy gamma (puts)", c.up, density.buy), line("Total", c.brass, density.neutral, true),
      ],
    };
  }, [density, lv, c]);
  const structOpt = useMemo(() => {
    if (structure.length < 2) return null;
    // a level more than 4% from spot is left off this panel (it would squash the price line); the table below has every level
    const near = (p: (typeof structure)[number], v: number | null) => (v != null && Math.abs(v - p.spot) / p.spot <= 0.04 ? v : null);
    const ser = (name: string, color: string, f: (p: (typeof structure)[number]) => number | null, dash: string, width = 1.4) => ({
      name, type: "line", xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, data: structure.map((p) => [p.t, f(p)]), lineStyle: { color, type: dash, width }, itemStyle: { color },
    });
    return {
      animation: false,
      grid: [{ left: 76, right: 20, top: 56, height: "36%" }, { left: 76, right: 20, top: "55%", height: "17%" }, { left: 76, right: 20, top: "77%", height: "13%" }],
      legend: { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, extraCssText: "max-width:260px",
        formatter: (ps: { value: [number, number | null]; seriesName: string; marker: string }[]) => {
          const rows = ps.filter((x) => x.value?.[1] != null).map((x) => `${x.marker} ${x.seriesName}: <b>${x.seriesName.includes("GEX") ? `${fmtCrore(x.value[1])} cr` : fmtInt(Math.round(x.value[1] as number))}</b>`);
          return `${ps[0] ? hhmm(ps[0].value[0]) : ""} IST<br/>${rows.join("<br/>")}`;
        } },
      xAxis: [0, 1, 2].map((i) => ({ type: "time", gridIndex: i, ...(w.bounds ? { min: w.bounds.min, max: w.bounds.max } : {}), axisLabel: { show: i === 2, color: c.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => hhmm(v) }, axisLine: { lineStyle: { color: c.rule } }, splitLine: { show: true, lineStyle: { color: c.rule, opacity: 0.25 } } })),
      yAxis: [
        { type: "value", gridIndex: 0, scale: true, name: "Spot and levels", nameTextStyle: { color: c.muted, fontSize: 10, align: "left" }, axisLabel: { color: c.muted, formatter: (v: number) => fmtInt(Math.round(v)) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
        { type: "value", gridIndex: 1, name: "Net GEX (cr)", nameTextStyle: { color: c.muted, fontSize: 10, align: "left" }, axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
        { type: "value", gridIndex: 2, name: "Change per minute (cr)", nameTextStyle: { color: c.muted, fontSize: 10, align: "left" }, axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      ],
      series: [
        ser("Spot", c.brass, (p) => p.spot, "solid", 2),
        ser("Call wall", c.down, (p) => near(p, p.callWall), "dashed"), ser("Put wall", c.up, (p) => near(p, p.putWall), "dashed"),
        ser("Peak gamma", c.info, (p) => near(p, p.peak), "dotted"), ser("Gamma flip", c.muted, (p) => near(p, p.flip), "dotted"),
        { name: "Net GEX", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: structure.map((p) => ({ value: [p.t, p.net], itemStyle: { color: (p.net ?? 0) >= 0 ? c.info : c.down } })) },
        { name: "GEX change per minute", type: "bar", xAxisIndex: 2, yAxisIndex: 2, data: structure.map((p) => ({ value: [p.t, p.roc], itemStyle: { color: (p.roc ?? 0) >= 0 ? c.up : c.down } })) },
      ],
    };
  }, [structure, c, w.bounds]);
  const barsOpt = useMemo(() => {
    if (visible.length === 0) return null;
    const rows = [...visible].reverse();
    return {
      animation: false, grid: { left: 62, right: 14, top: 30, bottom: 28 },
      legend: { top: 0, left: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      tooltip: { trigger: "axis", confine: true, axisPointer: { type: "shadow" }, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: number | null) => (v == null ? MISSING : `${fmtCrore(v)} cr`) },
      xAxis: { type: "value", axisLabel: { color: c.muted, formatter: (v: number) => fmtCrore(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.5 } } },
      yAxis: { type: "category", data: rows.map((r) => String(r.strike)), axisLabel: { color: c.paper, fontSize: 11 }, axisLine: { lineStyle: { color: c.rule } } },
      series: [
        { name: "Absolute GEX", type: "bar", barWidth: "55%", data: rows.map((r) => r.abs), itemStyle: { color: c.rule } },
        { name: "Net GEX", type: "bar", barWidth: "30%", barGap: "-60%", data: rows.map((r) => ({ value: r.net, itemStyle: { color: (r.net ?? 0) >= 0 ? c.info : c.down } })) },
      ],
    };
  }, [visible, c]);

  if (!d.expiry) return <EmptyState title="No expiry">Choose an expiry above.</EmptyState>;
  if (d.chain.isPending) return <p className="p-3 text-sm text-muted">Loading the option chain…</p>;
  if (!d.snapshot || !profile || !lv) return <EmptyState title="No snapshot stored for this expiry yet">{d.noSnapshot ? "Refresh or start the stream to store one." : "No option-chain data to show."}</EmptyState>;
  if (lv.netTotal == null) return <EmptyState title="Gamma exposure could not be computed">No strike has both a usable price and open interest on both sides ({profile.skipped} contracts skipped).</EmptyState>;

  const top = [...profile.rows].filter((r) => r.net != null).sort((a, b) => Math.abs(b.net!) - Math.abs(a.net!)).slice(0, 10);
  const distFlip = lv.flip == null ? null : ((lv.flip - lv.spot) / lv.spot) * 100;
  const bias = lv.flip == null ? "No gamma flip within ±8% of spot: the aggregate keeps one sign across that range." : lv.spot >= lv.flip ? `Spot is ${Math.abs(distFlip!).toFixed(2)}% above the gamma flip (${lvl(lv.flip)}): the ${lv.netTotal >= 0 ? "stabilizing" : "destabilizing"} side of the model.` : `Spot is ${Math.abs(distFlip!).toFixed(2)}% below the gamma flip (${lvl(lv.flip)}): the ${lv.netTotal >= 0 ? "stabilizing" : "destabilizing"} side of the model.`;
  const tfBtn = (m: number) => <button key={m} type="button" aria-pressed={tf === m} onClick={() => setTf(m)} className={pill(tf === m)}>{m}m</button>;
  return (
    <div className="flex flex-col gap-3" data-testid="gamma-analysis">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2 text-sm">
        <label className="flex items-center gap-2 text-muted">Strike range
          <select aria-label="Strike range" value={range} onChange={(e) => setRange(Number(e.target.value))} className={field}>{RANGES.map((n) => <option key={n} value={n}>±{n}</option>)}</select>
        </label>
        <div role="group" aria-label="Display type" className="flex items-center gap-1">
          <span className="mr-1 text-muted">Display</span>
          {([["combined", "Combined"], ["ce", "Calls only"], ["pe", "Puts only"]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={type === id} onClick={() => setType(id)} className={pill(type === id)}>{label}</button>)}
        </div>
        <button type="button" aria-pressed={levelsOn} onClick={() => setLevelsOn((x) => !x)} className={pill(levelsOn)}>Level lines</button>
        <button type="button" aria-pressed={absOn} onClick={() => setAbsOn((x) => !x)} className={pill(absOn)}>Absolute GEX line</button>
        <span className="text-xs text-muted">Expiry {d.expiry} · chain stored {new Date(atMs + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")} IST · {lv.strikesUsed} strikes used, {profile.skipped} contracts skipped</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="gamma-cards">
        <Card label="Spot price" value={fmtInt(Math.round(lv.spot * 10) / 10)} sub="NIFTY" tone="text-info" />
        <Card label="Max pain" value={lvl(pain)} sub="expiry magnet (OI only)" />
        <Card label="Call wall" value={lvl(lv.callWall)} sub="largest call GEX at or above spot" tone="text-down" />
        <Card label="Put wall" value={lvl(lv.putWall)} sub="largest put GEX at or below spot" tone="text-up" />
        <Card label="Peak gamma" value={lvl(lv.peak)} sub="largest absolute GEX" />
        <Card label="Gamma flip" value={lvl(lv.flip)} sub={lv.flip == null ? "none within ±8%" : "net GEX changes sign"} />
        <Card label="Aggregate net GEX" value={fmtCrore(lv.netTotal)} sub="₹ crore per 1% move, calls − puts" tone={lv.netTotal >= 0 ? "text-up" : "text-down"} />
      </div>

      {regime && (
        <div className={`rounded-[var(--radius-panel)] border px-4 py-3 ${regime.name === "Positive Gamma" ? "border-up/40 bg-up/5" : regime.name === "Negative Gamma" ? "border-down/40 bg-down/5" : "border-warn/40 bg-warn/5"}`} data-testid="gamma-regime">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-paper">{regime.name}</h2><span className="rounded-sm border border-rule px-1.5 py-0.5 text-[11px] text-muted">{regime.volatility}</span></div>
          <p className="text-sm text-paper">{regime.summary}</p>
          <p className="text-sm text-muted">{regime.expectation}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-sm border border-rule bg-slate px-2 py-0.5">Net GEX (1%): {fmtCrore(lv.netTotal)}</span>
            <span className="rounded-sm border border-rule bg-slate px-2 py-0.5">ATM GEX: {fmtCrore(lv.atmNet)}</span>
            <span className="rounded-sm border border-rule bg-slate px-2 py-0.5">Near-ATM net GEX (±5 strikes): {fmtCrore(lv.nearNet)}</span>
          </div>
          <p className="mt-2 text-[11px] text-muted">Sign convention: calls positive, puts negative (the market assumed long calls and short puts). Dealer positions are not published; if the real positioning were the reverse, the profile would invert. Read it as a map of exposure, not a signal.</p>
        </div>
      )}

      <Section title="Regime, corridor and bias">
        <div className="grid gap-3 p-3 md:grid-cols-3" data-testid="gamma-reading">
          <div className="rounded-sm bg-slate-2 p-3"><div className="text-[11px] text-muted">Regime</div><div className="font-medium text-paper">{regime?.name ?? MISSING}</div></div>
          <div className="rounded-sm bg-slate-2 p-3"><div className="text-[11px] text-muted">Corridor</div><div className="num font-medium text-paper">{lvl(cor?.lower)} – {lvl(cor?.upper)}</div><div className="text-[11px] text-muted">{cor?.widthPct == null ? "needs a level on each side of spot" : `width ${cor.widthPct.toFixed(2)}% · nearest of put wall, call wall, peak, flip and max pain`}</div></div>
          <div className="rounded-sm bg-slate-2 p-3"><div className="text-[11px] text-muted">Position against the flip</div><div className="font-medium text-paper">{bias}</div></div>
        </div>
        <p className="px-3 pb-3 text-[11px] text-muted">Levels only. No entry, target or stop is derived here: that needs price acceptance, volume and event context that this data does not carry.</p>
      </Section>

      <Section title="GEX profile" right={<span className="text-xs text-muted">bars above zero support reversion, bars below zero add acceleration (under the convention) · spot {fmtInt(Math.round(lv.spot * 10) / 10)}</span>}>
        <div className="p-2">{profileOpt && <div style={{ height: 380 }}><EChart option={profileOpt} ariaLabel="Gamma exposure by strike" /></div>}</div>
      </Section>

      <GexUniversesSection rows={d.rows} spot={lv.spot} expiry={d.expiry!} atMs={atMs} openAtm={openAtm} />

      <Section title="Gamma density (all strikes)" right={<label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} className="accent-[var(--brass)]" /> Extra smooth</label>}>
        <div className="p-2">
          {densityOpt && density ? (
            <>
              <div style={{ height: 340 }}><EChart option={densityOpt} ariaLabel="Smoothed call, put and total gamma concentration across strikes" /></div>
              <p className="px-1 pt-1 text-[11px] text-muted" data-testid="gamma-density-note">
                {profile.rows.filter((r) => r.ce != null || r.pe != null).length} strikes, Gaussian smoothing{extra ? " (extra wide)" : ""}. Sell gamma peaks at {lvl(density.sellPeak)} (call-side concentration), buy gamma at {lvl(density.buyPeak)} (put-side), the total at {lvl(density.neutralPeak)}. Sell × buy intersection: {density.sellBuy.length ? density.sellBuy.map((x) => lvl(x)).join(", ") : "none"}. Smoothing blends neighbouring strikes, so peaks can sit between strikes.
              </p>
            </>
          ) : <p className="p-3 text-sm text-muted">Too few strikes with exposure to draw a density.</p>}
          {density && (
            <MethodologyPanel metrics={[METRICS.gamma_density!]}
              example={[`Smoothing ${extra ? "extra wide (×2)" : "normal (×1)"}: kernel width h = 1.5 × median strike gap × smooth`, `Sell-gamma peak ${lvl(density.sellPeak)}, buy-gamma peak ${lvl(density.buyPeak)}, total peak ${lvl(density.neutralPeak)}`, `Sell/buy intersections: ${density.sellBuy.length ? density.sellBuy.map((x) => fmtInt(Math.round(x))).join(", ") : "none"}`]}
              freshness={{ updatedAt: new Date(atMs).toISOString(), session: new Date(atMs + 330 * 60_000).toISOString().slice(0, 10), expiry: d.expiry, used: profile.rows.filter((r) => r.ce != null || r.pe != null).length, missing: profile.rows.length - profile.rows.filter((r) => r.ce != null || r.pe != null).length, timeframe: "snapshot, full chain" }} />
          )}
        </div>
      </Section>

      <Section title="Underlying and net GEX through the session" right={<span className="flex flex-wrap items-center gap-2 text-xs text-muted">{structure.length} points · session {w.day ?? MISSING}<span role="group" aria-label="Timeframe" className="flex gap-1">{TFS.map(tfBtn)}</span></span>}>
        <div className="border-b border-rule px-3 py-2">{w.controls}</div>
        <div className="p-2">
          {q.isPending && !!key ? <p className="p-3 text-sm text-muted">Loading stored samples…</p>
            : q.error ? <p className="p-3 text-sm text-down">Could not load the stored series: {String((q.error as Error).message)}</p>
            : structOpt ? (
              <>
                <div style={{ height: 560 }}><EChart option={structOpt} ariaLabel="Spot, walls, peak and gamma flip with net GEX and its change per minute through the session" /></div>
                <p className="px-1 pt-1 text-[11px] text-muted" data-testid="gamma-structure-note">
                  Computed from 21 strikes around the open at-the-money strike ({lvl(openAtm)}), one value per {tf}-minute candle (its last stored sample); the profile above uses the whole chain, so totals differ. Lower panel: change of net GEX per minute since the previous candle. A wall, the peak or the flip that moves from candle to candle is less dependable than one that persists.
                </p>
              </>
            ) : <p className="p-3 text-sm text-muted" data-testid="gamma-structure-empty">Not enough stored samples with prices and open interest to draw the session ({structure.length} usable).</p>}
        </div>
      </Section>

      {d.expiry && <GexSessionIntel expiry={d.expiry} listed={listed} openAtm={openAtm} curAtm={lv.atmStrike} />}

      <div className="grid gap-3 lg:grid-cols-3" data-testid="gamma-dashboard">
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 text-sm"><div className="mb-1 text-[11px] font-semibold uppercase text-info">Intraday</div><p className="text-muted">Resistance {lvl(lv.callWall)}, support {lvl(lv.putWall)}, peak gamma {lvl(lv.peak)}. {regime?.name === "Positive Gamma" ? `Mean reversion toward ${lvl(lv.peak)} is the modelled tendency.` : regime?.name === "Negative Gamma" ? "Moves that break a wall are more likely to extend, in the model." : "The regime is unstable here; give the walls less weight."}</p></div>
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 text-sm"><div className="mb-1 text-[11px] font-semibold uppercase text-warn">Options</div><p className="text-muted">{regime?.name === "Negative Gamma" ? `Negative aggregate gamma goes with larger realised moves in the model, so options near ${lvl(lv.peak)} are more exposed to a break of ${lvl(cor?.lower)}–${lvl(cor?.upper)}.` : `Positive aggregate gamma goes with smaller realised moves in the model, so options priced for a large move away from ${lvl(cor?.lower)}–${lvl(cor?.upper)} lose value faster if spot stays inside it.`} Time to expiry changes this quickly: recheck after the next snapshot.</p></div>
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3 text-sm"><div className="mb-1 text-[11px] font-semibold uppercase text-down">Risk</div><p className="text-muted">{lv.flip == null ? "No flip within ±8%: the regime does not change across that range." : `The gamma flip at ${lvl(lv.flip)} (${fmtPct(distFlip)} from spot) is where the modelled regime changes.`} Walls are exposure concentrations, not guaranteed barriers; event days can override them.</p></div>
      </div>

      <Section title="Strike-by-strike gamma" right={<span className="rounded-sm border border-rule px-2 py-0.5 text-[11px] text-muted">top 10 by net GEX size</span>}>
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[640px] text-xs" data-testid="gamma-table">
            <thead><tr className="text-left text-[11px] uppercase text-muted"><th className="px-3 py-2 font-medium">Rank</th><th className="px-3 py-2 font-medium">Strike</th><th className="px-3 py-2 text-right font-medium">Net GEX (cr)</th><th className="px-3 py-2 text-right font-medium">CE gamma</th><th className="px-3 py-2 text-right font-medium">PE gamma</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Implication</th></tr></thead>
            <tbody>
              {top.map((r, i) => {
                const ty = strikeType(r, lv);
                return (
                  <tr key={r.strike} className="border-t border-rule/50">
                    <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                    <td className="px-3 py-1.5 text-paper">{fmtInt(r.strike)}{r.strike === lv.atmStrike && <span className="ml-1 rounded-sm border border-info/50 px-1 text-[10px] text-info">ATM</span>}</td>
                    <td className={`px-3 py-1.5 text-right ${(r.net ?? 0) >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>{(r.net ?? 0) >= 0 ? "+" : ""}{fmtCrore(r.net)}</td>
                    <td className="px-3 py-1.5 text-right text-up">{r.ceGamma == null ? MISSING : r.ceGamma.toFixed(4)}</td>
                    <td className="px-3 py-1.5 text-right text-down">{r.peGamma == null ? MISSING : r.peGamma.toFixed(4)}</td>
                    <td className="px-3 py-1.5">{ty && <span className="rounded-sm border border-rule px-1.5 py-0.5 text-[10px]">{ty}</span>}</td>
                    <td className="px-3 py-1.5 text-muted">{ty ? IMPLICATION[ty] : MISSING}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="GEX by strike" right={<span className="rounded-sm border border-rule px-2 py-0.5 text-[11px] text-muted">{type === "combined" ? "Combined gamma" : type === "ce" ? "Calls" : "Puts"}</span>}>
        <div className="p-2">{barsOpt && <div style={{ height: Math.max(320, visible.length * 22 + 70) }}><EChart option={barsOpt} ariaLabel="Absolute and net gamma exposure by strike" /></div>}</div>
      </Section>
    </div>
  );
}
