import { useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import { MISSING } from "../../lib/format";
import { sessionDays, sessionWindow } from "../../lib/analytics";
import { strikesAround } from "../../lib/optionTools";
import { rupee, TIME_LINES_RIGHT, timeLinesOption, type Line } from "../../lib/priceCharts";
import { sessionOpenMin } from "../../lib/session";
import {
  anchoredBand, candles, percentileRank, readingOf, regimeOf, stats, vegaChange, vegaLevel, vegaSamples,
  type ChangePoint, type LevelPoint,
} from "../../lib/vegaAnalysis";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { useDash } from "./DashContext";
import { useClipped } from "./ReplayContext";
import { useSessionWindow } from "./PriceBoards";

const GROUP_A = "vega-level";
const GROUP_B = "vega-change";
const TFS = [1, 3, 5, 15];
const PER_SIDE = [5, 10, 15, 21];
const MIN_SAMPLES = 100; // a percentile needs a real history: at least this many stored samples over at least two sessions
const MIN_SESSIONS = 2;
const v3 = (v: number | null | undefined) => (v == null ? MISSING : v.toFixed(3));
const signed2 = (v: number | null | undefined, unit = "") => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}${unit}`);
const ordinal = (n: number) => { const r = Math.round(n); const s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][r % 10 > 3 ? 0 : r % 10]!; return `${r}${s}`; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "05 Nov 26, 3:40 pm" in IST */
function stamp(ms: number): string {
  const d = new Date(ms + 330 * 60_000);
  const h = d.getUTCHours();
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
}
const pill = (on: boolean) => `widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const field = "widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";

export function Card({ label, value, sub, tone }: { label: string; value: ReactNode; sub: ReactNode; tone?: string }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num text-xl font-semibold ${tone ?? "text-paper"}`}>{value}</div>
      <div className="text-[11px] text-muted">{sub}</div>
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-3 py-2">
        <h2 className="text-sm font-semibold text-paper">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

/** Vega analysis of one strike window (level, replay) and of an anchored band (change since a baseline), from the stored one-minute samples. */
export function VegaAnalysisBoard() {
  const d = useDash();
  const c = useChartColors();
  const w = useSessionWindow();
  const [tf, setTf] = useState(5);
  const [near, setNear] = useState(1);
  const [pick, setPick] = useState<number | null>(null);
  const [perSide, setPerSide] = useState(21);
  const [base, setBase] = useState(0);
  const [normalized, setNormalized] = useState(false);
  const [showSel, setShowSel] = useState(false);
  const [showFwd, setShowFwd] = useState(true);
  const [show, setShow] = useState({ call: true, put: true, price: true, diff: true, range: false, run: false });

  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((a, b) => a - b), [d.rows]);
  const all = d.history.data?.observations;
  // the at-the-money strike of the first sample of the shown session anchors the band; the selected strike defaults to the newest ATM
  const openAtm = useMemo(() => (all && w.since ? (all.find((o) => o.retrieved_at === w.since)?.atm_strike ?? null) : null), [all, w.since]);
  const sel = pick ?? d.atmStrike ?? openAtm;
  const band = useMemo(() => (openAtm == null ? null : anchoredBand(listed, openAtm, perSide)), [listed, openAtm, perSide]);
  const win = useMemo(() => {
    if (sel == null || listed.length === 0) return [];
    let i = 0;
    listed.forEach((k, j) => { if (Math.abs(k - sel) < Math.abs(listed[i]! - sel)) i = j; });
    return listed.slice(Math.max(0, i - near), i + near + 1);
  }, [listed, sel, near]);
  const fetchKey = useMemo(() => {
    const set = new Set<number>([...(band?.ce ?? []), ...(band?.pe ?? []), ...win]);
    const arr = [...set].sort((a, b) => a - b);
    return (arr.length > 45 ? strikesAround(arr, sel, 45) : arr).join(",");
  }, [band, win, sel]);
  // the whole stored history of the selected window (all sessions) is the reference for the percentile
  const histKey = win.join(",");
  const days = sessionDays(all ?? []);
  const histSince = useMemo(() => (days.length > 0 ? sessionWindow(all ?? [], days[days.length - 1]!, "fit").since : undefined), [all, days]);

  const q = useQuery({
    queryKey: ["vegaDay", d.expiry, fetchKey, w.since, w.until],
    queryFn: () => api.strikeSeries(d.expiry!, fetchKey, w.since, w.until),
    enabled: !!d.expiry && !!w.since && !!fetchKey, refetchInterval: w.until ? false : 30_000, retry: false, placeholderData: keepPreviousData,
  });
  const hq = useQuery({
    queryKey: ["vegaHistory", d.expiry, histKey, histSince],
    queryFn: () => api.strikeSeries(d.expiry!, histKey, histSince),
    enabled: !!d.expiry && !!histSince && !!histKey, refetchInterval: 120_000, retry: false,
  });
  // the shared replay on this page (components/dashboard/ReplayBar.tsx) cuts what was stored at the replay time
  const qSeries = useClipped(q.data);
  const hSeries = useClipped(hq.data);
  const samples = useMemo(() => (qSeries && d.expiry ? vegaSamples(qSeries, d.expiry).filter((s) => !w.day || s.day === w.day) : []), [qSeries, d.expiry, w.day]);
  const hist = useMemo(() => (hSeries && d.expiry ? vegaSamples(hSeries, d.expiry) : []), [hSeries, d.expiry]);

  const levelAll = useMemo(() => vegaLevel(samples, win), [samples, win]);
  const level = useMemo(() => candles(levelAll, tf, sessionOpenMin()), [levelAll, tf]);
  const last = level.length - 1;
  const at = last; // the replay cuts the data itself, so the newest candle is always the one shown
  const now: LevelPoint | undefined = level[at];
  const histLevel = useMemo(() => vegaLevel(hist, win), [hist, win]);
  const histAvg = histLevel.map((p) => p.avg).filter((x): x is number => x != null);
  const histDays = new Set(histLevel.map((p) => p.day)).size;
  const enough = histAvg.length >= MIN_SAMPLES && histDays >= MIN_SESSIONS;
  const rankCe = enough ? percentileRank(histLevel.map((p) => p.ce).filter((x): x is number => x != null), now?.ce ?? null) : null;
  const rankPe = enough ? percentileRank(histLevel.map((p) => p.pe).filter((x): x is number => x != null), now?.pe ?? null) : null;
  const rank = enough ? percentileRank(histAvg, now?.avg ?? null) : null;
  const regime = regimeOf(rank);
  const reading = readingOf(regime, rank, histAvg.length, now?.diff ?? null, now?.avg ?? null);
  const ceStats = stats(level.slice(0, at + 1).map((p) => p.ce));
  const peStats = stats(level.slice(0, at + 1).map((p) => p.pe));
  const avgStats = stats(level.slice(0, at + 1).map((p) => p.avg));

  const optA = useMemo(() => {
    const shown = level.slice(0, at + 1);
    const t = shown.map((p) => p.t);
    const lines: Line[] = [];
    if (show.price) lines.push({ name: "Price", color: c.muted, data: shown.map((p) => p.spot), dotted: true, fmt: rupee });
    if (show.call) lines.push({ name: "Call Vega", color: c.up, data: shown.map((p) => p.ce), axis: 1, fmt: v3 });
    if (show.put) lines.push({ name: "Put Vega", color: c.down, data: shown.map((p) => p.pe), axis: 1, fmt: v3 });
    if (show.run) {
      let sum = 0; let n = 0;
      lines.push({ name: "Running average", color: c.brass, data: shown.map((p) => { if (p.avg == null) return null; sum += p.avg; n++; return sum / n; }), axis: 1, dotted: true, fmt: v3 });
    }
    if (show.range && avgStats.high != null && avgStats.low != null) {
      lines.push({ name: "Day high (avg)", color: c.info, data: shown.map(() => avgStats.high), axis: 1, dotted: true, fmt: v3 });
      lines.push({ name: "Day low (avg)", color: c.info, data: shown.map(() => avgStats.low), axis: 1, dotted: true, fmt: v3 });
    }
    if (lines.every((l) => l.axis !== 1)) lines.push({ name: "Vega", color: "transparent", data: shown.map(() => null), axis: 1, fmt: v3 });
    return timeLinesOption(t, lines, c, w.bounds, { leftFmt: (v) => fmtInt(v), rightFmt: (v) => v.toFixed(2) });
  }, [level, at, show, c, w.bounds, avgStats.high, avgStats.low]);
  const optDiff = useMemo(() => {
    const shown = level.slice(0, at + 1);
    return {
      animation: false, grid: { left: 58, right: TIME_LINES_RIGHT, top: 8, bottom: 24 },
      tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (x: number | null) => v3(x) },
      xAxis: { type: "time", ...(w.bounds ? { min: w.bounds.min, max: w.bounds.max } : {}), axisLabel: { color: c.muted, fontSize: 11, hideOverlap: true, formatter: (x: number) => new Date(x + 330 * 60_000).toISOString().slice(11, 16) }, axisLine: { lineStyle: { color: c.rule } } },
      yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, fontSize: 10, formatter: (x: number) => x.toFixed(2) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      series: [{ name: "CE − PE", type: "bar", data: shown.map((p) => ({ value: [p.t, p.diff], itemStyle: { color: (p.diff ?? 0) >= 0 ? c.up : c.down } })) }],
    };
  }, [level, at, c, w.bounds]);

  // ---- Vega change of the anchored band
  const changeAll: ChangePoint[] = useMemo(() => (band ? vegaChange(samples, band.ce, band.pe, base, normalized) : []), [samples, band, base, normalized]);
  // the candles keep the last sample of each period; the baseline sample itself (zero) is kept as the first row
  const change = useMemo(() => { const c = candles(changeAll, tf, sessionOpenMin()); return changeAll[0] && c[0]?.t !== changeAll[0].t ? [changeAll[0], ...c] : c; }, [changeAll, tf]);
  const selChange = useMemo(() => (showSel && sel != null ? candles(vegaChange(samples, [sel], [sel], base, normalized), tf, sessionOpenMin()) : []), [showSel, sel, samples, base, normalized, tf]);
  const unit = normalized ? "%" : "";
  const optB = useMemo(() => {
    const t = change.map((p) => p.t);
    const lines: Line[] = [];
    if (showFwd) lines.push({ name: "Synthetic Future", color: c.muted, data: change.map((p) => p.fwd), dotted: true, fmt: rupee });
    lines.push({ name: "Call Vega", color: c.up, data: change.map((p) => p.call), axis: 1, area: true, fmt: (x) => signed2(x, unit) });
    lines.push({ name: "Put Vega", color: c.down, data: change.map((p) => p.put), axis: 1, area: true, fmt: (x) => signed2(x, unit) });
    if (showSel && selChange.length) {
      const byT = new Map(selChange.map((p) => [p.t, p]));
      lines.push({ name: `Call ${fmtInt(sel ?? 0)}`, color: c.info, data: t.map((x) => byT.get(x)?.call ?? null), axis: 1, dotted: true, fmt: (x) => signed2(x, unit) });
      lines.push({ name: `Put ${fmtInt(sel ?? 0)}`, color: c.brass, data: t.map((x) => byT.get(x)?.put ?? null), axis: 1, dotted: true, fmt: (x) => signed2(x, unit) });
    }
    return timeLinesOption(t, lines, c, w.bounds, { leftFmt: (v) => fmtInt(v), rightFmt: (v) => signed2(v, unit), zeroLine: true });
  }, [change, selChange, showFwd, showSel, sel, c, w.bounds, unit]);

  const chg = change[change.length - 1];
  const baseOptions = samples.slice(0, 10).map((s, i) => ({ i, label: `${i + 1}${["st", "nd", "rd"][i] ?? "th"} (${new Date(s.t + 330 * 60_000).toISOString().slice(11, 16)})` }));

  if (!d.expiry) return <EmptyState title="No expiry">Choose an expiry above.</EmptyState>;
  if (d.chain.isPending || d.history.isPending) return <p className="p-3 text-sm text-muted">Loading stored samples…</p>;
  if (!d.snapshot) return <EmptyState title="No snapshot stored for this expiry yet">{d.noSnapshot ? "Refresh or start the stream to store one." : "No option-chain data to show."}</EmptyState>;
  if (w.afterHoursOnly || !w.since) return <EmptyState title="No session samples stored yet">The sampler stores one sample a minute during the market session. Only after-hours samples exist for this expiry.</EmptyState>;
  if (q.error) return <EmptyState title="Could not load the stored series">{String((q.error as Error).message)}</EmptyState>;
  if (q.isPending) return <p className="p-3 text-sm text-muted">Loading stored samples…</p>;
  if (level.length < 2) return <EmptyState title="Not enough usable samples">Vega needs at least two stored samples in the session with prices for the chosen strikes ({level.length} so far).</EmptyState>;

  const toggle = (k: keyof typeof show) => setShow((s) => ({ ...s, [k]: !s[k] }));
  const tfBtn = (m: number) => <button key={m} type="button" aria-pressed={tf === m} onClick={() => setTf(m)} className={pill(tf === m)}>{m}m</button>;
  return (
    <div className="flex flex-col gap-3" data-testid="vega-analysis">
      <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
        {w.controls}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-2 text-muted">Strike
            <select aria-label="Strike" value={pick == null ? "atm" : String(pick)} onChange={(e) => { setPick(e.target.value === "atm" ? null : Number(e.target.value)); }} className={field}>
              <option value="atm">ATM{d.atmStrike != null ? ` (${fmtInt(d.atmStrike)})` : ""}, latest</option>
              {listed.map((k) => <option key={k} value={k}>{fmtInt(k)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted">Strikes each side
            <select aria-label="Strikes each side" value={near} onChange={(e) => setNear(Number(e.target.value))} className={field}>
              {[0, 1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span className="text-xs text-muted">Window: {win.map((k) => fmtInt(k)).join(", ") || MISSING}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="vega-cards">
        <Card label="CE vega" value={v3(now?.ce)} sub={rankCe == null ? "percentile needs more history" : `${ordinal(rankCe)} percentile`} tone="text-up" />
        <Card label="PE vega" value={v3(now?.pe)} sub={rankPe == null ? "percentile needs more history" : `${ordinal(rankPe)} percentile`} tone="text-down" />
        <Card label="Average vega" value={v3(now?.avg)} sub={`across ${win.length} strike${win.length === 1 ? "" : "s"}, calls and puts`} />
        <Card label="Vega skew" value={v3(now?.diff)} sub={now?.diff == null ? "—" : Math.abs(now.diff) / (now.avg || 1) < 0.01 ? "balanced" : now.diff > 0 ? "CE higher sensitivity" : "PE higher sensitivity"} />
        <Card label="Vega regime" value={regime ?? MISSING} sub={enough ? `${histAvg.length} stored samples, ${histDays} session${histDays === 1 ? "" : "s"}` : "not enough stored history"} />
        <Card label="Vega rank" value={rank == null ? MISSING : `${rank.toFixed(0)}%`} sub="position in the stored history" />
      </div>

      <Section title="Vega — volatility sensitivity" right={<span className="flex items-center gap-2 text-xs text-muted">NIFTY · {w.day} · at {now ? stamp(now.t) : MISSING}<span role="group" aria-label="Timeframe" className="flex gap-1">{TFS.map(tfBtn)}</span></span>}>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2" role="group" aria-label="Overlays">
          <button type="button" aria-pressed={show.call} onClick={() => toggle("call")} className={pill(show.call)}>Call Vega</button>
          <button type="button" aria-pressed={show.put} onClick={() => toggle("put")} className={pill(show.put)}>Put Vega</button>
          <button type="button" aria-pressed={show.price} onClick={() => toggle("price")} className={pill(show.price)}>Price</button>
          <button type="button" aria-pressed={show.diff} onClick={() => toggle("diff")} className={pill(show.diff)}>CE−PE</button>
          <button type="button" aria-pressed={show.range} onClick={() => toggle("range")} className={pill(show.range)} title="The day's highest and lowest average vega so far">Daily range</button>
          <button type="button" aria-pressed={show.run} onClick={() => toggle("run")} className={pill(show.run)} title="Running average of the average vega since the open">Run avg</button>
        </div>
        <div className="p-2">
          <div style={{ height: 380 }}><EChart group={GROUP_A} option={optA} ariaLabel="Call vega, put vega and NIFTY through the session" /></div>
          {show.diff && <div style={{ height: 110 }}><EChart group={GROUP_A} option={optDiff} ariaLabel="Call vega minus put vega" /></div>}
          <p className="px-1 pt-1 text-[11px] text-muted" data-testid="vega-axes">
            {stamp(now?.t ?? 0)} · CE {v3(now?.ce)} · PE {v3(now?.pe)} · CE − PE {v3(now?.diff)} · Price {now ? rupee(now.spot) : MISSING}. Left axis: NIFTY (dotted). Right axis: vega in rupees per volatility point per unit. Each point is the last stored sample of its {tf}-minute candle.
          </p>
        </div>
      </Section>

      <Section title="Vega change" right={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={normalized} onChange={(e) => setNormalized(e.target.checked)} className="accent-[var(--brass)]" /> Normalized (% of baseline)</label>
          <label className="flex items-center gap-1.5">Baseline
            <select aria-label="Baseline" value={base} onChange={(e) => setBase(Number(e.target.value))} className={field}>{baseOptions.map((o) => <option key={o.i} value={o.i}>{o.label}</option>)}</select>
          </label>
          <label className="flex items-center gap-1.5">Strikes per side
            <select aria-label="Strikes per side" value={perSide} onChange={(e) => setPerSide(Number(e.target.value))} className={field}>{PER_SIDE.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
        </span>
      }>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-3 py-2 text-xs text-muted">
          <span>Strikes per side · CE {band && band.ce.length ? `${fmtInt(band.ce[0]!)} – ${fmtInt(band.ce[band.ce.length - 1]!)}` : MISSING} · PE {band && band.pe.length ? `${fmtInt(band.pe[0]!)} – ${fmtInt(band.pe[band.pe.length - 1]!)}` : MISSING} · anchored at the open ATM {openAtm != null ? fmtInt(openAtm) : MISSING}</span>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={showFwd} onChange={(e) => setShowFwd(e.target.checked)} className="accent-[var(--brass)]" /> Synthetic future</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={showSel} onChange={(e) => setShowSel(e.target.checked)} className="accent-[var(--brass)]" /> Selected strike ({sel != null ? fmtInt(sel) : MISSING})</label>
        </div>
        <div className="p-2">
          <div style={{ height: 380 }}><EChart group={GROUP_B} option={optB} ariaLabel="Change in the summed call and put vega since the baseline" /></div>
          <p className="px-1 pt-1 text-[11px] text-muted" data-testid="vega-change-note">
            Sum of vega over the call strikes from the open ATM upwards and the put strikes from it downwards, minus the same strikes&apos; vega at the baseline sample ({baseOptions[base]?.label ?? MISSING}); a strike counts only if it had a price at both moments. {normalized ? "Normalized: the change as a percentage of the band's vega at the baseline." : "In rupees per volatility point per unit."} Latest: call {signed2(chg?.call, unit)}, put {signed2(chg?.put, unit)}{chg ? ` (${chg.ceN} call and ${chg.peN} put strikes)` : ""}.
          </p>
        </div>
        <div className="border-t border-rule">
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted"><span>Chart values · latest first</span><span className="rounded-sm border border-rule bg-slate-2 px-2 py-0.5">{change.length} points</span></div>
          <div className="max-h-[360px] overflow-y-auto" data-testid="vega-change-table">
            <table className="num w-full text-xs">
              <thead className="sticky top-0 bg-slate-2 text-[11px] uppercase text-muted"><tr><th className="px-3 py-1.5 text-left font-medium">Time</th><th className="px-3 py-1.5 text-right font-medium">Call vega</th><th className="px-3 py-1.5 text-right font-medium">Put vega</th></tr></thead>
              <tbody>
                {[...change].reverse().map((p) => (
                  <tr key={p.t} className="border-t border-rule/50">
                    <td className="px-3 py-1 text-paper">{stamp(p.t)}</td>
                    <td className={`px-3 py-1 text-right ${(p.call ?? 0) >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>{signed2(p.call, unit)}</td>
                    <td className={`px-3 py-1 text-right ${(p.put ?? 0) >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>{signed2(p.put, unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Vega statistics">
          <div className="grid grid-cols-2 gap-4 p-3 text-sm" data-testid="vega-stats">
            {[{ name: "Call options (CE)", s: ceStats }, { name: "Put options (PE)", s: peStats }].map(({ name, s }) => (
              <div key={name}>
                <div className="mb-1 font-medium text-paper">{name}</div>
                <dl className="space-y-1 text-muted">
                  <div className="flex justify-between"><dt>Current</dt><dd className="num text-paper">{v3(s.current)}</dd></div>
                  <div className="flex justify-between"><dt>Average</dt><dd className="num text-paper">{v3(s.average)}</dd></div>
                  <div className="flex justify-between"><dt>Range</dt><dd className="num text-paper">{v3(s.low)} – {v3(s.high)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <p className="px-3 pb-3 text-[11px] text-muted">Of the {level.slice(0, at + 1).length} candles of this session shown so far, for the window {win.map((k) => fmtInt(k)).join(", ")}.</p>
        </Section>
        <Section title="Vega insights">
          <div className="space-y-2 p-3 text-sm" data-testid="vega-insights">
            <div className="rounded-sm bg-slate-2 p-2"><div className="font-medium text-paper">Vega environment{regime ? `: ${regime}` : ""}</div><p className="text-muted">{reading.environment}</p></div>
            <div className="rounded-sm bg-slate-2 p-2"><div className="font-medium text-paper">Vega skew</div><p className="text-muted">{reading.skew}</p></div>
            <div className="rounded-sm bg-slate-2 p-2"><div className="font-medium text-paper">Change of the band</div><p className="text-muted">
              {chg == null || chg.call == null || chg.put == null ? "No change could be computed for this band." : `Since the baseline the call side's vega moved ${signed2(chg.call, unit)} and the put side's ${signed2(chg.put, unit)}: ${Math.abs(chg.call) > Math.abs(chg.put) ? "calls" : "puts"} gained the larger share of sensitivity. Vega moves with spot (strikes drift in or out of the money), time to expiry and implied volatility together.`}
            </p></div>
            <p className="text-[11px] text-muted">Vega says how much a price would move for a one-point change in implied volatility; it is not a forecast that volatility will rise or fall. The regime is our own rule on the stored history: the lowest third is low, the highest third high; the percentile needs at least {MIN_SAMPLES} stored samples over {MIN_SESSIONS} sessions, which exist only for the sessions this server has stored.</p>
          </div>
        </Section>
      </div>
    </div>
  );
}
