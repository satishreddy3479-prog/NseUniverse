import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { minuteAligned } from "../../lib/refresh";
import { sessionOpenMin } from "../../lib/session";
import { strikesAround } from "../../lib/optionTools";
import type { SmartOiResult } from "../../lib/optionTools";
import {
  alignFuture, analyseSmartOi, buildStrikeFlow, collapseBursts, DIVERGENCE_TIMEFRAMES, INDICATOR_NAMES, scoreBursts, TH, tfp, type Burst, type DivergenceReport, type Direction, type Score,
} from "../../lib/smartOiDivergence";
import { useClipped } from "./ReplayContext";

export { DIVERGENCE_TIMEFRAMES };
const arrow = (d: Direction) => (d === "bullish" ? "▲" : d === "bearish" ? "▼" : "●");
const tone = (d: Direction) => (d === "bullish" ? "text-up" : d === "bearish" ? "text-down" : "text-muted");
const gradeTip: Record<string, string> = { A: "clean candles in the window", B: "one or two candles in the window are flagged (a gap, a changed strike count, a stand-in price)", C: "three or more flagged candles, or the index feed stalled today: read with care" };

export interface DivergenceData { on: boolean; report: DivergenceReport | null; bursts: Burst[]; score: ReturnType<typeof scoreBursts> | null }
/**
 * The divergence indicators of the candles shown (lib/smartOiDivergence.ts), for 1, 3 and 5 minute candles: the same data feeds the signals panel of the Smart OI chart and the cards below it, so
 * both follow the timeframe chosen. The per-strike series (who is writing, where) and the NIFTY future are fetched beside the Smart OI totals; an indicator whose input is missing says so and
 * stays silent.
 */
export function useDivergence(res: SmartOiResult | null, tf: number, since: string | undefined, expiry: string | null, listed: number[], openAtm: number | null): DivergenceData {
  const on = (DIVERGENCE_TIMEFRAMES as readonly number[]).includes(tf);
  const strikeKey = useMemo(() => (openAtm == null ? "" : strikesAround(listed, openAtm, 21).join(",")), [listed, openAtm]);
  const sq = useQuery({
    queryKey: ["smartOiDivStrikes", expiry, strikeKey, since],
    queryFn: () => api.strikeSeries(expiry!, strikeKey, since),
    enabled: on && !!expiry && !!since && !!strikeKey, refetchInterval: minuteAligned, retry: false, placeholderData: keepPreviousData,
  });
  const fq = useQuery({ queryKey: ["smartOiDivFuture", since], queryFn: () => api.futuresSeries(since), enabled: on && !!since, refetchInterval: minuteAligned, retry: false });
  const ss = useClipped(sq.data);
  const fut = useClipped(fq.data);
  const report: DivergenceReport | null = useMemo(() => {
    if (!on || !res || res.candles.length < 4) return null;
    const flow = ss ? buildStrikeFlow(res, ss, sessionOpenMin()) : undefined;
    return analyseSmartOi(res, { strikeFlow: flow, future: fut ? alignFuture(res, fut) : undefined });
  }, [on, res, ss, fut]);
  const bursts = useMemo(() => (report ? collapseBursts(report.signals) : []), [report]);
  const score = useMemo(() => (res ? scoreBursts(bursts, res.candles.map((x) => x.spot?.close ?? null), Math.max(1, Math.round(15 / tf)), tf) : null), [res, bursts, tf]);
  return { on, report, bursts, score };
}

/** The cards below the Smart OI chart: the seven indicators and their agreement, the scorecard, the signals in words, and what each one means. The markers themselves are in the chart. */
export function SmartOiDivergence({ res, tf, d }: { res: SmartOiResult | null; tf: number; d: DivergenceData }) {
  const { on, report, bursts, score } = d;
  if (!on) {
    return <p className="rounded-sm border border-rule bg-slate-2 px-3 py-2 text-sm text-muted" data-testid="div-off">Divergence indicators are built for 1, 3 and 5 minute candles. Choose one of them above to see them (the lower panel of the chart shows volume on other candle lengths).</p>;
  }
  if (!res || !report) {
    return <p className="rounded-sm border border-rule bg-slate-2 px-3 py-2 text-sm text-muted" data-testid="div-wait">Divergences need at least four {tf}-minute candles of stored samples.</p>;
  }
  const c = report.composite;
  const recent = [...bursts].reverse().slice(0, 14);
  return (
    <section aria-label="Divergence indicators" className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="divergence">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-paper">Divergence indicators <span className="text-xs font-normal text-muted">· {tf}-minute candles · indicator, not validated</span></h3>
          <p className={`text-sm font-semibold ${tone(c.direction)}`} data-testid="div-composite">{arrow(c.direction)} {c.text}</p>
          <p className="mt-0.5 text-xs text-muted" data-testid="div-contrarian">A divergence is a disagreement with price. A bullish one during a fall means something under the fall is turning up; a bearish one during a rise means the rise is losing support. It is a warning to look closer, not a forecast of direction.</p>
        </div>
        <span className="rounded-full border border-rule bg-slate-2 px-3 py-1 text-xs font-semibold text-paper" title={gradeTip[c.grade]} data-testid="div-grade">Evidence {c.grade}<span className="ml-1 font-normal text-muted">{gradeTip[c.grade]!.split(" (")[0]}</span></span>
      </header>
      <ul className="grid gap-2 md:grid-cols-2" data-testid="div-readings">
        {report.readings.map((r) => (
          <li key={r.id} className={`rounded-sm border px-3 py-2 ${r.active ? "border-rule bg-slate-2" : "border-rule/60"}`} data-testid={`div-${r.id}`} data-active={r.active ? "true" : "false"}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-paper">{INDICATOR_NAMES[r.id]}</span>
              {r.active ? <span className={`num text-sm font-semibold ${tone(r.direction)}`}>{arrow(r.direction)} {r.direction} divergence · {Math.round(r.strength * 100)}% · {r.at}</span> : <span className="text-xs text-muted">quiet</span>}
            </div>
            <p className={`mt-0.5 text-xs ${r.active ? "text-paper" : "text-muted"}`}>{r.text}</p>
            {r.active && <div className="mt-1 h-1 overflow-hidden rounded-full bg-rule" aria-hidden><div className={`h-full ${r.direction === "bullish" ? "bg-up" : r.direction === "bearish" ? "bg-down" : "bg-muted"}`} style={{ width: `${Math.round(r.strength * 100)}%` }} /></div>}
          </li>
        ))}
      </ul>
      <p className=" text-xs text-muted" data-testid="div-chart-note">
            In the lower panel of the chart above: <span className="text-up">▲</span> under the price line: something other than price leans bullish, <span className="text-down">▼</span> above it: bearish, <span>●</span> a notable reading with no direction. One marker is the <b>start</b> of a run of the same signal (hover it for how long it lasted and why). One marker per candle: when several indicators start on the same candle they share one marker (hover to list them), and when they disagree it is a neutral dot. A hollow marker failed.
          </p>
      {score && <Scorecard sc={score} />}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Signals today, newest first</h4>
        {recent.length === 0 ? <p className="text-sm text-muted" data-testid="div-none">No divergence signal has formed today on {tf}-minute candles.</p> : (
          <ul className="flex flex-col gap-1" data-testid="div-events">
            {recent.map((s, k) => (
              <li key={`${s.id}-${s.i}-${k}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="num text-muted">{s.at}{s.count > 1 ? `–${s.lastAt}` : ""}</span>
                <span className={`font-semibold ${tone(s.direction)}`}>{arrow(s.direction)} {INDICATOR_NAMES[s.id]}</span>
                {s.count > 1 && <span className="rounded-sm border border-rule px-1 text-[11px] text-muted" title={`The same signal held for ${s.count} candles in a row`}>×{s.count}</span>}
                {s.state === "failed" && <span className="rounded-sm border border-warn/50 px-1 text-[11px] text-warn" title="Price later went beyond the swing the signal was built on">failed</span>}
                <span className="text-muted">{s.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="text-xs text-muted" data-testid="div-notes">
        <summary className="cursor-pointer text-info">How to read these, and what they cannot tell you</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li><b>Flow</b>: at confirmed swing highs and lows (a swing needs {tfp(tf).pivotK} candles each side, so it is known {tfp(tf).pivotK * tf} minutes late) price and the day's cumulative Smart OI are compared. Regular: they disagree about the new extreme. Hidden: price makes a smaller extreme while flow makes a larger one. Failed: price later went beyond the swing.</li>
          <li><b>Writing or buying</b>: each strike's OI change read with its premium change after taking out what the index move explains (each premium is re-priced for the new index level and the time that passed; what the whole chain did together, a forward shift and a volatility move, is fitted and removed, so only what a strike did on its own counts). OI up with the premium down is writing, up with the premium up is buying; OI down with the premium up is covering, down with the premium down is unwinding. Two candles in a row where this contradicts the Smart OI label.</li>
          <li><b>Conviction</b>: new OI per option contract traded against the day's usual level. A move with plenty of volume and little new OI is churn; new OI building without a move is absorption.</li>
          <li><b>PCR</b>: what is held (OI PCR) against what is traded (volume PCR) and against price over {TH.windowMin} minutes.</li>
          <li><b>Future against options</b>: the future's price and OI (long build-up, short build-up, short covering, long unwinding) against the direction of Smart OI over {TH.windowMin} minutes.</li>
          <li><b>Zone</b>: put OI added below spot against call OI added above it, against price. Price rising into a growing ceiling or falling onto a growing floor.</li>
          <li><b>Momentum</b>: the smoothed speed of Smart OI against price over {TH.windowMin} minutes, and readings that are unusual for this day (robust z-score of {TH.momZ} or more).</li>
          <li><b>Composite</b>: a direction needs {TH.composite.minAgree} indicators agreeing and a lead of {TH.composite.minLead} over the other side, each active within the last {TH.windowMin} minutes.</li>
          <li>Smart OI is built from stored one-minute samples (a candle's change is a difference of two samples). The per-strike indicators use ATM ±10 strikes of the day's opening at-the-money strike. A divergence says price and positioning disagree, not which one is right. The thresholds are provisional and are being tested on stored sessions; nothing here is an order or a target.</li>
        </ul>
      </details>
      {(report.missing.strikes || report.missing.future) && (
        <p className="text-xs text-muted" data-testid="div-missing">{report.missing.strikes ? "The stored per-strike series is not available: writing or buying and zone are silent. " : ""}{report.missing.future ? "The stored NIFTY future series is not available: the future indicator is silent." : ""}</p>
      )}
    </section>
  );
}

const pctTxt = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)} %`);
/** How today's signals fared ``horizonMin`` minutes after each started (see ``scoreBursts``). */
function Scorecard({ sc }: { sc: ReturnType<typeof scoreBursts> }) {
  const rows: [string, Score][] = [["Bullish divergences", sc.bullish], ["Bearish divergences", sc.bearish]];
  return (
    <section aria-label="Scorecard of today's signals" data-testid="div-scorecard" className="rounded-sm border border-rule bg-slate-2 p-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Scorecard: how today's signals fared {sc.horizonMin} minutes later</h4>
      <div className="overflow-x-auto">
        <table className="mt-1 w-full min-w-[420px] text-xs">
          <thead className="text-muted"><tr><th className="px-2 py-1 text-left font-normal">Signals</th><th className="px-2 py-1 text-right font-normal">Count</th><th className="px-2 py-1 text-right font-normal">Right</th><th className="px-2 py-1 text-right font-normal">Wrong</th><th className="px-2 py-1 text-right font-normal">Not judged yet</th><th className="px-2 py-1 text-right font-normal" title="The move of the index in the direction the signal pointed, averaged">Average move</th></tr></thead>
          <tbody>
            {rows.map(([label, s]) => (
              <tr key={label} data-testid={`score-${label.startsWith("Bull") ? "bullish" : "bearish"}`} className="border-t border-rule/50">
                <td className="px-2 py-1 font-medium text-paper">{label}</td><td className="num px-2 py-1 text-right">{s.signals}</td>
                <td className="num px-2 py-1 text-right text-up">{s.right}</td><td className="num px-2 py-1 text-right text-down">{s.wrong}</td>
                <td className="num px-2 py-1 text-right text-muted">{s.pending}</td><td className={`num px-2 py-1 text-right ${s.meanMove == null ? "text-muted" : s.meanMove > 0 ? "text-up" : s.meanMove < 0 ? "text-down" : ""}`}>{pctTxt(s.meanMove)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sc.byIndicator.length > 0 && (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer text-info">By indicator</summary>
          <ul className="mt-1 grid gap-x-6 sm:grid-cols-2" data-testid="score-by-indicator">
            {sc.byIndicator.map((e) => <li key={`${e.id}/${e.direction}`}>{INDICATOR_NAMES[e.id]} ({e.direction}): <span className="text-up">{e.score.right} right</span>, <span className="text-down">{e.score.wrong} wrong</span>{e.score.pending > 0 ? `, ${e.score.pending} not judged yet` : ""}{e.score.flat > 0 ? `, ${e.score.flat} flat` : ""}</li>)}
          </ul>
        </details>
      )}
      <p className="mt-1 text-xs text-muted" data-testid="score-note">
        Each signal is judged once, by the index {sc.horizonMin} minutes after the candle it started on: right if the index moved the way the signal pointed, wrong if it moved the other way. Signals after the cash close or too recent to judge are counted as not judged yet. A divergence points against price, so on a day that trends one way the opposite signals are wrong again and again; a handful of signals proves nothing either way. Neutral dots ({sc.neutral}) point nowhere and are not judged.
      </p>
    </section>
  );
}
