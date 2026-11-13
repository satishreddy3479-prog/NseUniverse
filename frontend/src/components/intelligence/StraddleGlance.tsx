import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { isSessionMs } from "../../lib/analytics";
import { MISSING, fmtTimeIST } from "../../lib/format";
import { timeLinesOption, type Line } from "../../lib/priceCharts";
import type { Component, StraddleDecay, Terms } from "../../lib/straddleDecay";
import { EChart, useChartColors } from "../EChart";

type Colors = ReturnType<typeof useChartColors>;
type Mode = "fixed" | "rolling";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const inr = (v: number) => `${v < 0 ? "−" : "+"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

/** Score bands (lower bound, label) as the backend classifies them: worst first so the bar reads bad → good. */
export const SELLER_ZONES: [number, string][] = [[0, "High risk"], [25, "Unfavourable"], [40, "Neutral"], [60, "Favourable"], [80, "Highly favourable"]];
export const BUYER_ZONES: [number, string][] = [[0, "Unfavourable"], [30, "Neutral"], [45, "Selective"], [60, "Favourable"], [75, "Strong"]];
const ZONE_BG = ["bg-down/60", "bg-down/35", "bg-warn/45", "bg-up/40", "bg-up/65"];

export function Gauge({ title, subtitle, score, cls, zones, trend, coverage, testid, capped }: {
  title: string; subtitle: string; score: number | null; cls: string; zones: [number, string][]; capped?: string | null;
  trend: { now: number | null; m15: number | null; m30: number | null } | null | undefined; coverage: number; testid: string;
}) {
  const move = score != null && trend?.m15 != null ? score - trend.m15 : null;
  const pos = (v: number) => `${Math.max(0, Math.min(100, v))}%`;
  return (
    <div className="rounded-xl border border-rule bg-ink/40 p-4" data-testid={testid}>
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-[12rem] flex-1"><div className="text-sm font-semibold text-paper">{title}</div><div className="text-xs leading-snug text-muted">{subtitle}</div></div>
        {move != null && Math.abs(move) >= 0.5 && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${move > 0 ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>{move > 0 ? "▲" : "▼"} {Math.abs(move).toFixed(0)} vs 15 min ago</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2"><span className="num text-4xl font-bold text-paper" data-testid={`${testid}-score`}>{score == null ? MISSING : score.toFixed(0)}</span><span className="text-sm text-muted">/ 100</span><span className="ml-1 text-base font-semibold text-paper">{cls}</span></div>
      <div className="relative mt-3" aria-label={`${title} score ${score == null ? "unavailable" : score.toFixed(0)} of 100`}>
        <div className="flex h-3 overflow-hidden rounded-full">
          {zones.map(([lo, name], i) => <div key={name} className={ZONE_BG[i]} style={{ width: `${(i + 1 < zones.length ? zones[i + 1]![0] : 100) - lo}%` }} title={`${name}: ${lo}+`} />)}
        </div>
        {trend?.m15 != null && <span className="absolute -top-1 h-5 w-0.5 rounded bg-paper/50" style={{ left: pos(trend.m15) }} title={`15 minutes ago: ${trend.m15.toFixed(0)}`} />}
        {score != null && <span className="absolute -top-1.5 grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full border-2 border-paper bg-ink text-[9px] font-bold text-paper" style={{ left: pos(score) }}>●</span>}
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" data-testid={`${testid}-zones`} aria-label="Score zones">
          {zones.map(([lo, name], i) => {
            const hi = i + 1 < zones.length ? zones[i + 1]![0] : 101;
            const here = score != null && score >= lo && score < hi;
            return <li key={name} className={`flex items-center gap-1 whitespace-nowrap ${here ? "font-semibold text-paper" : ""}`}><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${ZONE_BG[i]}`} />{name} <span className="num opacity-70">{lo}+</span></li>;
          })}
        </ul>
      </div>
      {capped && <p className="mt-2 rounded-md bg-warn/10 px-2 py-1 text-xs leading-snug text-paper" data-testid={`${testid}-cap`}>The score sits in a higher zone, but the label is held at <b>{capped}</b> because a risk flag is active (see the flags under Why these scores).</p>}
      <p className="mt-2 text-[11px] text-muted">Built from {Math.round(coverage * 100)}% of the evidence inputs. 15 minutes ago: {trend?.m15 == null ? "not recorded" : trend.m15.toFixed(0)}{trend?.m30 != null ? ` · 30 minutes ago: ${trend.m30.toFixed(0)}` : ""}.</p>
    </div>
  );
}

/** Contribution of every component to a score, in points above or below the neutral 50: green pushes the score up, red pulls it down. */
function driversOption(items: Component[], c: Colors, up: string): EChartsCoreOption {
  const rows = items.filter((x) => x.contribution != null).sort((a, b) => (a.contribution as number) - (b.contribution as number));
  return {
    animation: false, grid: { left: 8, right: 36, top: 6, bottom: 22, containLabel: true },
    tooltip: { trigger: "item", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: unknown) => {
      const r = rows[(p as { dataIndex: number }).dataIndex]!;
      return `<b>${r.name}</b><br/>${sg(r.contribution)} points · weight ${r.weight}<br/><span style="opacity:.8">${r.text}</span>`;
    } },
    xAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => (v > 0 ? `+${v}` : `${v}`) }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
    yAxis: { type: "category", data: rows.map((r) => r.name), axisLabel: { color: c.paper, fontSize: 11, width: 150, overflow: "truncate" }, axisTick: { show: false }, axisLine: { lineStyle: { color: c.muted } } },
    series: [{ type: "bar", barMaxWidth: 16, data: rows.map((r) => ({ value: r.contribution, itemStyle: { color: (r.contribution as number) >= 0 ? up : c.down, borderRadius: 3 } })),
      label: { show: true, position: "right", color: c.paper, fontSize: 11, formatter: (p: { value: number }) => sg(p.value) } }],
  };
}

const TERM_LABEL: [keyof Terms | "other", string][] = [["theta", "Time passing (theta)"], ["vega", "Volatility change (vega)"], ["delta", "NIFTY moving (delta)"], ["gamma", "Curvature (gamma)"], ["other", "Other effects"], ["actual", "Actual change"]];
const termValue = (t: Terms, k: keyof Terms | "other") => (k === "other" ? (t.vanna ?? 0) + (t.volga ?? 0) + t.residual : (t[k] as number));

/** The glance: scores with zones, why, fixed against rolling, where the premium change came from, what each side kept, and the score history. */
/** Which part of the glance a tab shows: the score history (Overview), what the premium did today (Today), why the scores are what they are (Why), how the charts are drawn and the words (Method). */
export type GlancePart = "history" | "today" | "why" | "method";

export function StraddleGlance({ d, mode, setMode, part }: { d: StraddleDecay; mode: Mode; setMode: (m: Mode) => void; part: GlancePart }) {
  const c = useChartColors();
  const tr = d.tracker, env = d.environment;
  const times = useMemo(() => (d.times ?? []).map((t) => new Date(t).getTime()), [d.times]);
  const lot = [d.attribution?.fixed.open, d.attribution?.fixed["60"], d.attribution?.fixed["30"], d.attribution?.rolling.open, d.attribution?.rolling["60"], d.attribution?.rolling["30"]].map((w) => w?.efficiency.lot_size).find((x) => x != null);

  const posName = mode === "fixed" ? `Fixed ${tr?.fixed.strike ?? ""}` : `Rolling ATM (now ${tr?.atm_now ?? MISSING})`;
  const change = useMemo(() => {
    if (!d.series || !d.cumulative) return null;
    const fx = d.series.fixed.straddle;
    const base = fx.find((v) => v != null);
    if (base == null) return null;
    const lines: Line[] = [
      { name: "Fixed", color: c.brass, data: fx.map((v) => (v == null ? null : Math.round((v - base) * 100) / 100)), fmt: (v) => sg(v) },
      { name: "Rolling ATM", color: c.info, data: d.cumulative.rolling.actual, fmt: (v) => sg(v) },
    ];
    if (d.spot) lines.push({ name: "NIFTY (right)", color: c.muted, data: d.spot, axis: 1, dotted: true, fmt: (v) => v.toLocaleString("en-IN") });
    const o = timeLinesOption(times, lines, c, null, { leftFmt: (v) => sg(v, 0), rightFmt: (v) => v.toLocaleString("en-IN"), zeroLine: true }) as unknown as { grid: Record<string, unknown>; legend: Record<string, unknown>; series: { name: string; lineStyle?: Record<string, unknown>; z?: number }[] };
    o.grid = { ...o.grid, top: 40 };
    o.legend = { ...o.legend, top: 4, left: "center", itemGap: 14 };
    // the position being followed is drawn bold, the other one thin and faded, so choosing a position visibly changes the chart
    const on = mode === "fixed" ? "Fixed" : "Rolling ATM";
    for (const sr of o.series) {
      if (sr.name.startsWith("NIFTY")) continue;
      const sel = sr.name === on;
      sr.lineStyle = { ...(sr.lineStyle ?? {}), width: sel ? 3.2 : 1.2, opacity: sel ? 1 : 0.35 };
      sr.z = sel ? 5 : 2;
    }
    return o as unknown as EChartsCoreOption;
  }, [d, times, c, mode]);

  const sources = useMemo(() => {
    const f = d.attribution?.fixed.open?.both, r = d.attribution?.rolling.open?.both;
    if (!f || !r) return null;
    return {
      animation: false, grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
      legend: { top: 0, textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, valueFormatter: (v: unknown) => `${sg(Number(v), 2)} points` },
      xAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11 }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      yAxis: { type: "category", inverse: true, data: TERM_LABEL.map(([, n]) => n), axisLabel: { color: c.paper, fontSize: 11 }, axisTick: { show: false } },
      series: [
        { name: "Fixed", type: "bar", barMaxWidth: 14, itemStyle: { color: c.brass, opacity: mode === "fixed" ? 1 : 0.3 }, data: TERM_LABEL.map(([k]) => termValue(f, k)) },
        { name: "Rolling ATM", type: "bar", barMaxWidth: 14, itemStyle: { color: c.info, opacity: mode === "rolling" ? 1 : 0.3 }, data: TERM_LABEL.map(([k]) => termValue(r, k)) },
      ],
    } as EChartsCoreOption;
  }, [d, c, mode]);

  /** Call and put premium at the open and now for the followed position (the fixed strike, or the at-the-money strike of the first sample against the current one). */
  const kept = useMemo(() => {
    const pos = mode === "fixed" ? tr?.fixed : tr?.rolling;
    const ce = pos?.ce, pe = pos?.pe;
    if (ce?.open == null || pe?.open == null || ce.current == null || pe.current == null) return null;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return {
      animation: false, grid: { left: 8, right: 52, top: 34, bottom: 8, containLabel: true },
      legend: { top: 4, left: "center", textStyle: { color: c.paper, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      tooltip: { show: false },
      xAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11 }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      yAxis: { type: "category", inverse: true, data: ["Call (CE)", "Put (PE)"], axisLabel: { color: c.paper, fontSize: 12 }, axisTick: { show: false } },
      series: [
        { name: "At the open", type: "bar", barMaxWidth: 20, barGap: "15%", barCategoryGap: "30%", itemStyle: { color: c.muted, borderRadius: 3 }, data: [r1(ce.open), r1(pe.open)], label: { show: true, position: "right", color: c.paper, fontSize: 12 } },
        { name: "Now", type: "bar", barMaxWidth: 20, itemStyle: { color: mode === "fixed" ? c.brass : c.info, borderRadius: 3 }, data: [r1(ce.current), r1(pe.current)], label: { show: true, position: "right", color: c.paper, fontSize: 11 } },
      ],
    } as EChartsCoreOption;
  }, [tr, c, mode]);

  const hist = useMemo(() => {
    const h = d.history;
    if (!h) return null;
    const ht = (h.times ?? []).map((t) => new Date(t).getTime());
    const hs = [...h.seller], hb = [...h.buyer];
    // current reading as the last point, so the chart and the gauges agree; after the close nothing is added (a flat line to 17:45 would say the score was steady while the market was shut)
    const nowMs = d.generated_at ? new Date(d.generated_at).getTime() : NaN;
    if (env && Number.isFinite(nowMs) && ht.length > 0 && nowMs > (ht[ht.length - 1] as number) && isSessionMs(nowMs)) { ht.push(nowMs); hs.push(env.seller.score); hb.push(env.buyer.score); }
    if (ht.length < 2) return null;
    const f = (v: number) => v.toFixed(0);
    return timeLinesOption(ht, [{ name: "Seller environment", color: c.up, data: hs, fmt: f }, { name: "Buyer environment", color: c.brass, data: hb, fmt: f }], c, null, { leftFmt: f });
  }, [d, env, c]);

  const histEnd = d.history?.times?.length ? d.history.times[d.history.times.length - 1] : null;
  const generatedMs = d.generated_at ? new Date(d.generated_at).getTime() : NaN;
  const histLive = Number.isFinite(generatedMs) && isSessionMs(generatedMs);
  const fixedChg = tr?.fixed.straddle.change ?? null;
  const rollChg = tr?.rolling.adjusted_change ?? null;
  const sellerPnl = (pts: number | null) => (pts == null || lot == null ? null : -pts * lot);
  const sellerNote = (pts: number | null) => {
    const p = sellerPnl(pts);
    return p == null ? "" : ` A seller who sold it at the open ${p >= 0 ? "is ahead by" : "is behind by"} about ${inr(Math.abs(p)).slice(1)} per lot, before costs.`;
  };

  return (
    <div className="mt-3 space-y-3" data-testid="sdi-glance">
      {part === "today" && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-paper">Today at a glance</h3>
        <div role="group" aria-label="Position to follow" className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="sdi-follow">
          <span className="text-muted">Following</span>
          {tr && ([["fixed", `Fixed ${tr.fixed.strike}`], ["rolling", "Rolling ATM"]] as const).map(([m, l]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`min-h-9 rounded-full border px-3 ${mode === m ? "border-brass bg-brass/15 font-semibold text-paper" : "border-rule text-muted hover:text-paper"}`}>{l}</button>
          ))}
        </div>
      </div>
      )}

      {part === "today" && tr && (
        <section id="sdi-glance-compare" aria-label="Fixed against rolling" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-compare">
          <h4 className="text-sm font-semibold text-paper">Fixed against rolling: two ways to follow a straddle</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted" data-testid="sdi-following-note">You are following <b className="text-paper">{posName}</b>. Its line is bold in the charts below and the detailed sections further down use it; the other is shown faded for comparison. The two cards always show both.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {([
              ["fixed", `Fixed ${tr.fixed.strike}`, `The ${tr.fixed.strike} straddle that was at the money when the session opened${tr.opening_at ? ` (${fmtTimeIST(tr.opening_at)})` : ""}, held all day.`, tr.fixed.straddle.open, tr.fixed.straddle.current, fixedChg, "text-brass"],
              ["rolling", `Rolling ATM (now ${tr.atm_now ?? MISSING})`, `Always the straddle at the money right now; it has moved ${tr.rolling.rolls} time${tr.rolling.rolls === 1 ? "" : "s"} today. Changes are added only for the same contract, so a move makes no jump.`, tr.rolling.straddle.open, tr.rolling.straddle.current, rollChg, "text-info"],
            ] as const).map(([m, title, what, open, now, chg, col]) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`sdi-compare-${m}`}
                className={`rounded-lg border p-3 text-left transition-colors ${mode === m ? "border-brass bg-brass/5 ring-1 ring-brass/40" : "border-rule hover:border-muted"}`}>
                <div className={`text-sm font-semibold ${col}`}>{title}{mode === m && <span className="ml-2 rounded-full bg-brass/15 px-2 py-0.5 text-[10px] font-normal text-paper">shown in the sections below</span>}</div>
                <p className="mt-0.5 text-xs leading-snug text-muted">{what}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div><dt className="text-[11px] text-muted">At the open</dt><dd className="num text-lg font-semibold text-paper">{open == null ? MISSING : open.toFixed(1)}</dd></div>
                  <div><dt className="text-[11px] text-muted">Now</dt><dd className="num text-lg font-semibold text-paper">{now == null ? MISSING : now.toFixed(1)}</dd></div>
                  <div><dt className="text-[11px] text-muted">Change</dt><dd className={`num text-lg font-semibold ${chg == null ? "text-muted" : chg <= 0 ? "text-up" : "text-down"}`}>{sg(chg)}</dd></div>
                </dl>
                <p className="mt-1 text-[11px] leading-snug text-muted">{chg == null ? "Not enough data yet." : chg <= 0 ? "The premium has fallen (decayed)." : "The premium has risen."}{sellerNote(chg)}</p>
              </button>
            ))}
          </div>
          {change && <div className="mt-3"><div className="mb-1 text-xs text-muted">Change in premium since the open, in points (below zero = premium has decayed; NIFTY on the right axis)</div><div className="h-[250px]"><EChart group="sdi" option={change} ariaLabel="Change in straddle premium since the open: fixed against rolling" /></div></div>}
          {kept && <div className="mt-3"><div className="mb-1 text-xs text-muted">{mode === "fixed" ? `Call and put price of the fixed ${tr.fixed.strike} straddle: at the open and now (points)` : `Call and put price of the at-the-money strike: at the first sample (${tr.fixed.strike}) and now (${tr.atm_now ?? MISSING}). They are different strikes, so compare the level, not the decay`}</div><div className="h-[170px]"><EChart option={kept} ariaLabel="Call and put premium at the open and now for the followed position" /></div></div>}
        </section>
      )}

      {part === "why" && env && (
        <section id="sdi-glance-why" aria-label="Why these scores" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-why">
          <h4 className="text-sm font-semibold text-paper">Why these scores</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted">Each bar is one piece of evidence, in points above or below a neutral 50. Green pushes the score up, red pulls it down. Touch a bar for the reason.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div><div className="text-xs font-semibold text-paper">Seller score {env.seller.score == null ? "" : env.seller.score.toFixed(0)}</div><div className="mt-1" style={{ height: 28 + 26 * env.seller.components.filter((x) => x.contribution != null).length }}><EChart option={driversOption(env.seller.components, c, c.up)} ariaLabel="What moves the seller score" /></div></div>
            <div><div className="text-xs font-semibold text-paper">Buyer score {env.buyer.score == null ? "" : env.buyer.score.toFixed(0)}</div><div className="mt-1" style={{ height: 28 + 26 * env.buyer.components.filter((x) => x.contribution != null).length }}><EChart option={driversOption(env.buyer.components, c, c.brass)} ariaLabel="What moves the buyer score" /></div></div>
          </div>
        </section>
      )}

      {part === "today" && sources && (
        <section id="sdi-glance-sources" aria-label="What moved the premium" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-sources-chart">
          <h4 className="text-sm font-semibold text-paper">What moved the premium since the open</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted">Points of premium added (+) or taken away (−) by each cause, for both ways of following the straddle. Time passing should take premium away; NIFTY moving and volatility rising add it back.</p>
          <div className="mt-2 h-[250px]"><EChart option={sources} ariaLabel="Causes of the premium change since the open, fixed against rolling" /></div>
        </section>
      )}

      {part === "history" && hist && (
        <section aria-label="Score history" className="rounded-xl border border-rule bg-ink/40 p-3">
          <h4 className="text-sm font-semibold text-paper">How the scores moved today</h4>
          <div className="mt-1 h-[190px]"><EChart group="sdi" option={hist} ariaLabel="Seller and buyer environment score history" /></div>
          <p className="text-[11px] text-muted" data-testid="sdi-hist-note">{histLive ? "One recorded reading per minute; the last point is the current reading shown in the gauges above." : `One recorded reading per minute. The market is closed: the chart ends at the last recorded minute${histEnd ? ` (${fmtTimeIST(histEnd)} IST)` : ""}.`}</p>
        </section>
      )}

      {part === "method" && <>
      <details className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-plotted">
        <summary className="cursor-pointer text-sm font-semibold text-paper">How are these charts drawn?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
          <li><b className="text-paper">Data:</b> the option-chain samples stored about once a minute during the session (last traded prices, not bid/ask), plus the Market Intelligence engines for the score evidence.</li>
          <li><b className="text-paper">Fixed line:</b> call price + put price of the one strike chosen at the open ({tr?.fixed.strike ?? MISSING}), minus its opening value. It is the profit or loss, in premium points, of a straddle sold at the open and never adjusted.</li>
          <li><b className="text-paper">Rolling line:</b> at every minute the straddle at the strike nearest NIFTY is used, and only the change of the same contract between two minutes is added up. When the at-the-money strike moves, the new contract starts from its own price, so the line has no jump from switching strikes.</li>
          <li><b className="text-paper">Why they differ:</b> as NIFTY rises, the fixed strike goes in the money and its call gains while its put loses, so the fixed line mostly follows NIFTY. The rolling line keeps resetting to at the money, so it shows the decay and volatility change of an always-ATM straddle.</li>
          <li><b className="text-paper">Scores:</b> are computed once on the server from all the evidence and do not depend on which position you follow.</li>
        </ul>
      </details>

      <details className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-words">
        <summary className="cursor-pointer text-sm font-semibold text-paper">What do these words mean?</summary>
        <dl className="mt-2 grid gap-x-6 gap-y-2 text-xs leading-relaxed sm:grid-cols-2">
          {[
            ["Straddle", "A call and a put at the same strike. Its price is what the market charges for a move in either direction."],
            ["Decay (theta)", "Option premium shrinks as time passes. A seller wants this; a buyer fights it."],
            ["Volatility (vega, IV)", "If the market expects bigger moves, premiums rise even with no move in NIFTY."],
            ["Delta and gamma", "How the premium reacts when NIFTY moves, and how fast that reaction itself changes."],
            ["Fixed", "One strike chosen at the open and followed all day."],
            ["Rolling ATM", "Always the at-the-money strike right now."],
            ["Decay efficiency", "How much of the expected time decay actually showed up. Shown only once enough decay is expected for the number to mean something."],
            ["Score and coverage", "A 0-100 summary of the evidence. Coverage is how many of the inputs were available; missing inputs are left out, never counted as neutral."],
          ].map(([t, x]) => <div key={t}><dt className="font-semibold text-paper">{t}</dt><dd className="text-muted">{x}</dd></div>)}
        </dl>
      </details>
      </>}
    </div>
  );
}

