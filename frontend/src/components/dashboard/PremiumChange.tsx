import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { LayoutBar } from "../LayoutBar";
import { useViewLayout } from "../../lib/viewLayout";
import { strikesAround } from "../../lib/optionTools";
import { changeWindows, readout } from "../../lib/premiumChange";
import { PARTS, partColors, runningOption, spotOption, strikesOption, windowsOption } from "../../lib/premiumChangeCharts";
import { EChart, useChartColors } from "../EChart";
import { EmptyState } from "../ui";
import { Loading } from "../Loading";
import { NoExpiry } from "./NoExpiry";
import { useDash } from "./DashContext";
import { useClipped } from "./ReplayContext";
import { useSessionWindow } from "./PriceBoards";
import { Section } from "./VegaAnalysis";

const WINDOWS = [1, 3, 5, 15] as const;
const SIDES = [3, 5, 8, 10] as const;
const FETCH_STRIKES = 31; // the strike at the money moves through the day: the series keeps 15 either side of the newest one
const GROUP = "premium-change";
const pill = (on: boolean) => `widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
const field = "widget-nodrag min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper";
const hhmm = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/**
 * Premium Change: what drove the change of the ATM straddle (and of every strike's straddle) in each window: time passing, NIFTY moving, or volatility and the rest.
 * From the stored one-minute samples (the same ones as the other price tools), so a replay and a past session work the same way. Method and limits: lib/premiumChange.ts.
 */
export function PremiumChangeBoard() {
  const d = useDash();
  const c = useChartColors();
  const w = useSessionWindow();
  const L = useViewLayout("premium-change");
  const [minutes, setMinutes] = L.use<number>("minutes", 5);
  const [perSide, setPerSide] = L.use<number>("perSide", 5);
  const [picked, setPicked] = useState<number | null>(null); // the window being read: not part of a saved layout; null follows the newest
  const mins = (WINDOWS as readonly number[]).includes(minutes) ? minutes : 5;
  const side = (SIDES as readonly number[]).includes(perSide) ? perSide : 5;

  const listed = useMemo(() => [...new Set(d.rows.map((r) => r.strike))].sort((a, b) => a - b), [d.rows]);
  const all = d.history.data?.observations;
  const openAtm = useMemo(() => (all && w.since ? (all.find((o) => o.retrieved_at === w.since)?.atm_strike ?? null) : null), [all, w.since]);
  const centre = d.atmStrike ?? openAtm;
  const fetchKey = useMemo(() => strikesAround(listed, centre, FETCH_STRIKES).join(","), [listed, centre]);
  const q = useQuery({
    queryKey: ["premiumChange", d.expiry, fetchKey, w.since, w.until],
    queryFn: () => api.strikeSeries(d.expiry!, fetchKey, w.since, w.until),
    enabled: !!d.expiry && !!w.since && !!fetchKey, refetchInterval: w.until ? false : 30_000, retry: false, placeholderData: keepPreviousData,
  });
  const series = useClipped(q.data);
  const res = useMemo(() => (series && d.expiry ? changeWindows(series, d.expiry, mins) : null), [series, d.expiry, mins]);
  const windows = useMemo(() => (res ? res.windows.filter((x) => !w.day || x.day === w.day) : []), [res, w.day]);
  const labels = useMemo(() => windows.map((x) => hhmm(x.t)), [windows]);
  const last = windows.length - 1;
  const sel = picked != null && picked <= last ? picked : last;
  const chosen = windows[sel];

  const optWindows = useMemo(() => windowsOption(windows, labels, sel, c), [windows, labels, sel, c]);
  const optRunning = useMemo(() => runningOption(windows, labels, sel, c), [windows, labels, sel, c]);
  const optStrikes = useMemo(() => strikesOption(chosen, side, c), [chosen, side, c]);
  const optSpot = useMemo(() => spotOption(windows, labels, sel, c), [windows, labels, sel, c]);
  const pickLabel = (p: { name?: string }) => { const i = labels.indexOf(p.name ?? ""); if (i >= 0) setPicked(i === last ? null : i); };

  if (!d.expiry) return <NoExpiry />;
  if (d.chain.isPending || d.history.isPending) return <Loading label="Loading stored samples…" className="m-3" />;
  if (!d.snapshot) return <EmptyState title="No snapshot stored for this expiry yet">{d.noSnapshot ? "Refresh or start the stream to store one." : "No option-chain data to show."}</EmptyState>;
  if (w.afterHoursOnly || !w.since) return <EmptyState title="No session samples stored yet">The sampler stores one sample a minute during the market session. Only after-hours samples exist for this expiry.</EmptyState>;
  if (q.error) return <EmptyState title="Could not load the stored series">{String((q.error as Error).message)}</EmptyState>;
  if (q.isPending) return <Loading label="Loading stored samples…" className="m-3" />;
  if (windows.length < 2) return <EmptyState title="Not enough stored samples yet">Premium Change needs at least two {mins}-minute windows with prices in the session ({windows.length} so far).</EmptyState>;

  const sentence = chosen ? readout(chosen, mins, labels[sel]!) : null;
  const unsplit = windows.filter((x) => x.atm == null).length;
  return (
    <div className="flex flex-col gap-3" data-testid="premium-change">
      <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
        {w.controls}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div role="group" aria-label="Window" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Window</span>
            {WINDOWS.map((m) => <button key={m} type="button" aria-pressed={mins === m} onClick={() => { setMinutes(m); setPicked(null); }} className={pill(mins === m)}>{m} min</button>)}
          </div>
          <label className="flex items-center gap-2 text-muted">Strikes each side
            <select aria-label="Strikes each side" value={side} onChange={(e) => setPerSide(Number(e.target.value))} className={field}>
              {SIDES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <LayoutBar layout={L} className="ml-auto" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor="pc-time" className="text-muted">Window ending</label>
          <input id="pc-time" type="range" min={0} max={last} step={1} value={sel} onChange={(e) => { const i = Number(e.target.value); setPicked(i === last ? null : i); }}
            className="widget-nodrag h-9 min-w-[10rem] flex-1 cursor-pointer accent-[var(--brass)]" data-testid="pc-slider" aria-valuetext={labels[sel]} />
          <output htmlFor="pc-time" className="num min-w-[3.5rem] text-paper" data-testid="pc-time">{labels[sel]}</output>
          <button type="button" onClick={() => setPicked(null)} disabled={picked == null} className={`${pill(false)} disabled:opacity-40`}>Latest</button>
        </div>
      </div>

      <p role="status" className="rounded-[var(--radius-panel)] border border-rule bg-slate-2 px-3 py-2.5 text-sm leading-relaxed text-paper" data-testid="pc-readout">
        {sentence ?? `At ${labels[sel]} the straddle could not be split: a price or an implied volatility was missing in this window.`}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Key">
        {PARTS.map((p, k) => <span key={p.key} className="flex items-center gap-1.5"><span className="inline-block size-3 rounded-[2px]" style={{ background: partColors()[k] }} aria-hidden="true" />{p.name}</span>)}
      </div>

      <Section title={`ATM straddle: change in every ${mins}-minute window and what drove it`}>
        <div style={{ height: 240 }}><EChart group={GROUP} option={optWindows} onClick={pickLabel} ariaLabel="Change of the ATM straddle in every window, split into time decay, NIFTY moving, and volatility and the rest" /></div>
      </Section>
      <Section title="Added up through the day">
        <div style={{ height: 220 }}><EChart group={GROUP} option={optRunning} onClick={pickLabel} ariaLabel="Running total of each part from the first window of the day, and the real change" /></div>
        <p className="px-3 pb-2 text-[11px] text-muted">Each window is the straddle that was at the money then, so this adds window changes up; it is not the price of one straddle.</p>
      </Section>
      <Section title={`Every strike at ${labels[sel]}: what drove each straddle's change`}>
        <div style={{ height: Math.max(220, 40 + (2 * side + 1) * 24) }}><EChart option={optStrikes} ariaLabel="Change of each strike's straddle in the chosen window, split into the three parts" /></div>
      </Section>
      <Section title="NIFTY">
        <div style={{ height: 120 }}><EChart group={GROUP} option={optSpot} onClick={pickLabel} ariaLabel="NIFTY at the end of every window" /></div>
      </Section>

      <details className="rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2 text-sm text-muted" data-testid="pc-notes">
        <summary className="cursor-pointer text-info">How to read this, and its limits</summary>
        <div className="mt-2 flex flex-col gap-2 leading-relaxed">
          <p>Every {mins} minutes the straddle's real change is split into three parts that always add up to it: <b className="text-paper">time decay</b> (what the same prices would lose from the time passing), <b className="text-paper">NIFTY moving</b> (the move of the index, delta and gamma together), and <b className="text-paper">volatility and the rest</b> (what is left once those two are taken out).</p>
          <p>The last part is a remainder: it holds the change of implied volatility, but also quote noise, a forward that was a little off, and skew moving. It is not a pure implied-volatility measure.</p>
          <p>Black-76 with the forward read from put-call parity near the money and the model's usual interest rate. Windows run between the stored samples at multiples of {mins} minutes from the open. A window across a gap in the stored samples is left out ({res?.skippedWindows ?? 0} here), and a strike with no usable price or implied volatility is left out too, never counted as zero.</p>
          <p>This describes what happened. It does not say which way premiums will go next.</p>
          {unsplit > 0 && <p>{unsplit} window{unsplit === 1 ? "" : "s"} could not be split at the money and show as gaps.</p>}
        </div>
      </details>
    </div>
  );
}
