import { useState } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { EChart, useChartColors } from "./EChart";
import { compactIN } from "../lib/analytics";
import type { ChartColors } from "../lib/chartOptions";
import type { FlowsDay } from "../lib/types";
import {
  MOVE_LEAN, MOVE_TEXT, PARTICIPANTS, SEGMENTS, ascending, delta, fmtSigned, headlines, legs, longShare, netBalance, netRank, optionBias, streak,
  type MoveKind, type Participant,
} from "../lib/participantFlow";

const BASES = [
  { back: 1, label: "vs previous session" },
  { back: 5, label: "vs 1 week (5 sessions)" },
  { back: 10, label: "vs 2 weeks (10 sessions)" },
] as const;

const tone = (v: number | null | undefined) => (v == null ? "text-muted" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted");
const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN"));
const chip: Record<-1 | 0 | 1, string> = { 1: "bg-up/15 text-up", [-1]: "bg-down/15 text-down", 0: "bg-slate-2 text-muted" };

function MoveChip({ kind, futures }: { kind: MoveKind; futures: boolean }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${futures ? chip[MOVE_LEAN[kind]] : chip[0]}`}>{MOVE_TEXT[kind]}</span>;
}

function lineOption(cats: string[], series: { name: string; color: string; values: (number | null)[]; dashed?: boolean }[], c: ChartColors): EChartsCoreOption {
  return {
    animation: false, grid: { left: 58, right: 12, top: 30, bottom: 26 },
    legend: { top: 0, right: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: "axis", backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => (v == null ? "—" : Number(v).toLocaleString("en-IN")) },
    xAxis: { type: "category", data: cats, axisLabel: { color: c.muted, fontSize: 11, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: c.rule } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => compactIN(v) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    series: series.map((s) => ({ name: s.name, type: "line", symbolSize: 5, showSymbol: cats.length < 25, lineStyle: { width: 2, type: s.dashed ? "dashed" : "solid" }, itemStyle: { color: s.color }, data: s.values })),
  };
}

/** Advanced reading of the stored participant open-interest rows: who holds what, how it changed against the previous session, a week and two weeks ago. */
export function ParticipantAnalysis({ oi, volume }: { oi: FlowsDay[]; volume: FlowsDay[] }) {
  const colors = useChartColors();
  const [back, setBack] = useState<number>(1);
  const [who, setWho] = useState<Participant>("FII");
  const asc = ascending(oi);
  const n = asc.length;
  if (n < 2) {
    return <p className="rounded-xl border border-rule bg-ink/40 p-3 text-sm text-muted" data-testid="pa-short">Comparisons need at least two stored sessions; {n} stored so far.</p>;
  }
  const b = Math.min(back, n - 1);
  const capped = b < back;
  const newest = asc[n - 1]!;
  const lines = headlines(asc, volume, b);
  const cats = asc.map((d) => d.session);
  const pc = { FII: colors.info, DII: colors.brass, Pro: colors.up, Client: colors.down } as const;
  const bal = netBalance(newest, "idxFut");
  const sel = delta(asc, who, "idxFut", b);

  return (
    <div className="space-y-4" data-testid="participant-analysis">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Compare today with">
        <span className="text-xs text-muted">Today ({newest.session}) compared with</span>
        {BASES.map((x) => (
          <button key={x.back} type="button" aria-pressed={back === x.back} onClick={() => setBack(x.back)}
            className={`min-h-9 rounded-full border px-3 text-xs ${back === x.back ? "border-brass bg-brass/15 text-paper" : "border-rule text-muted hover:text-paper"}`}>{x.label}</button>
        ))}
        {capped && <span className="text-xs text-muted">only {n - 1} earlier sessions are stored: comparing with {asc[0]!.session}</span>}
      </div>

      <section aria-label="What is happening" className="rounded-xl border border-rule bg-ink/40 p-4">
        <h3 className="mb-2 text-sm font-semibold text-paper">What is happening</h3>
        <ul className="space-y-1.5 text-sm text-paper">
          {lines.map((t) => <li key={t} className="flex gap-2 leading-relaxed"><span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brass" />{t}</li>)}
        </ul>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Positioning by participant">
        {PARTICIPANTS.map((p) => {
          const d = delta(asc, p, "idxFut", b);
          const now = legs(newest, p, "idxFut");
          const share = now ? longShare(now) : null;
          const rk = netRank(asc, p, "idxFut");
          const st = streak(asc, p, "idxFut");
          return (
            <button key={p} type="button" onClick={() => setWho(p)} aria-pressed={who === p} aria-label={`${p} positioning`}
              className={`rounded-xl border p-3 text-left transition-colors ${who === p ? "border-brass bg-brass/5" : "border-rule bg-ink/40 hover:border-muted"}`}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold text-paper"><span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: pc[p] }} />{p}</span>
                {d && <MoveChip kind={d.kind} futures />}
              </div>
              <p className="mt-2 text-[11px] uppercase tracking-wider text-muted">Net index futures</p>
              <p className={`num text-2xl font-semibold ${tone(now?.net)}`}>{num(now?.net)}</p>
              <p className={`num text-xs ${tone(d?.dNet)}`}>{d ? `${fmtSigned(d.dNet)} ${BASES.find((x) => x.back === back)?.label.replace("vs ", "since ") ?? ""}` : "—"}</p>
              {share != null && now && (
                <div className="mt-3" aria-label={`${p} long share ${Math.round(share * 100)}%`}>
                  <div className="flex h-2 overflow-hidden rounded-full bg-down/40"><div className="bg-up/70" style={{ width: `${share * 100}%` }} /></div>
                  <div className="num mt-1 flex justify-between text-[11px] text-muted"><span>Long {num(now.long)}</span><span>Short {num(now.short)}</span></div>
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted">
                {rk ? (rk.lowest ? "Lowest net of " : rk.highest ? "Highest net of " : `Rank ${rk.rank} (1 = lowest) of `) + `${rk.of} sessions` : "Rank needs 3+ sessions"}
                {Math.abs(st) >= 2 ? ` · ${st > 0 ? "rising" : "falling"} ${Math.abs(st)} sessions` : ""}
              </p>
            </button>
          );
        })}
      </div>

      <section aria-label={`${who} detail`} className="rounded-xl border border-rule bg-ink/40 p-3">
        <h3 className="mb-2 text-sm font-semibold text-paper">{who}: today against {sel ? sel.thenSession : "—"}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm" aria-label={`${who} positions today and before`}>
            <thead className="text-xs text-muted">
              <tr><th className="text-left font-normal">Segment</th><th className="text-right font-normal">Long</th><th className="text-right font-normal">Δ long</th><th className="text-right font-normal">Short</th><th className="text-right font-normal">Δ short</th><th className="text-right font-normal">Net</th><th className="text-right font-normal">Δ net</th><th className="pl-3 text-left font-normal">What changed</th></tr>
            </thead>
            <tbody>
              {SEGMENTS.map((s) => {
                const d = delta(asc, who, s.id, b);
                return (
                  <tr key={s.id} className="num border-t border-rule/50">
                    <td className="py-1.5 text-left font-sans text-paper">{s.label}</td>
                    <td className="text-right">{num(d?.now.long)}</td><td className={`text-right ${tone(d?.dLong)}`}>{d ? fmtSigned(d.dLong) : "—"}</td>
                    <td className="text-right">{num(d?.now.short)}</td><td className={`text-right ${tone(d ? -d.dShort : null)}`}>{d ? fmtSigned(d.dShort) : "—"}</td>
                    <td className={`text-right ${tone(d?.now.net)}`}>{num(d?.now.net)}</td><td className={`text-right ${tone(d?.dNet)}`}>{d ? fmtSigned(d.dNet) : "—"}</td>
                    <td className="pl-3 text-left font-sans">{d ? <MoveChip kind={d.kind} futures={s.id === "idxFut" || s.id === "stkFut"} /> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Green change in the short column means shorts were reduced. Futures labels lean bullish (long build-up, short covering) or bearish (short build-up, long unwinding); for options the label only says which leg moved, because a short call and a long put point in different directions.</p>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="pa-legs-chart">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">{who} index futures: long, short and net (contracts)</p>
          <div className="h-56"><EChart ariaLabel={`${who} index futures long, short and net by session`} option={lineOption(cats, [
            { name: "Long", color: colors.up, values: asc.map((d) => legs(d, who, "idxFut")?.long ?? null) },
            { name: "Short", color: colors.down, values: asc.map((d) => legs(d, who, "idxFut")?.short ?? null) },
            { name: "Net", color: pc[who], values: asc.map((d) => legs(d, who, "idxFut")?.net ?? null), dashed: true },
          ], colors)} /></div>
        </div>
        <div className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="pa-options-chart">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">FII index options: net calls, net puts and bias (calls − puts)</p>
          <div className="h-56"><EChart ariaLabel="FII net index calls, puts and bias by session" option={lineOption(cats, [
            { name: "Net calls", color: colors.up, values: asc.map((d) => legs(d, "FII", "idxCall")?.net ?? null) },
            { name: "Net puts", color: colors.down, values: asc.map((d) => legs(d, "FII", "idxPut")?.net ?? null) },
            { name: "Bias (calls − puts)", color: colors.info, values: asc.map((d) => optionBias(d, "FII")), dashed: true },
          ], colors)} /></div>
        </div>
      </div>

      <div className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="pa-share-chart">
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted">Long share of each group&apos;s index-futures book (long ÷ (long + short), %)</p>
        <div className="h-52"><EChart ariaLabel="Long share of index futures book by participant and session" option={lineOption(cats, PARTICIPANTS.map((p) => ({
          name: p, color: pc[p], values: asc.map((d) => { const l = legs(d, p, "idxFut"); const s = l ? longShare(l) : null; return s == null ? null : Math.round(s * 1000) / 10; }),
        })), colors)} /></div>
      </div>

      <p className="text-xs text-muted" data-testid="pa-note">
        Positions are end-of-day open interest in contracts, not rupees and not a trade signal. Every long has a short, so the four groups&apos; index-futures nets add up to about zero
        ({bal == null ? "balance unavailable" : `today ${fmtSigned(bal)}`}): when FII are net short, someone else is net long. Sessions are the ones NSE published; days without a file are not filled in.
      </p>
    </div>
  );
}
