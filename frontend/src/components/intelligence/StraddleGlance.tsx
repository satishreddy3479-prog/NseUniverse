import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { MISSING, fmtTimeIST } from "../../lib/format";
import { timeLinesOption, type Line } from "../../lib/priceCharts";
import type { Component, StraddleDecay, Terms } from "../../lib/straddleDecay";
import { EChart, useChartColors } from "../EChart";

type Colors = ReturnType<typeof useChartColors>;
type Mode = "fixed" | "rolling";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const inr = (v: number) => `${v < 0 ? "−" : "+"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

/** Score bands (lower bound, label) as the backend classifies them: worst first so the bar reads bad → good. */
const SELLER_ZONES: [number, string][] = [[0, "High risk"], [25, "Unfavourable"], [40, "Neutral"], [60, "Favourable"], [80, "Highly favourable"]];
const BUYER_ZONES: [number, string][] = [[0, "Unfavourable"], [30, "Neutral"], [45, "Selective"], [60, "Favourable"], [75, "Strong"]];
const ZONE_BG = ["bg-down/60", "bg-down/35", "bg-warn/45", "bg-up/40", "bg-up/65"];

function Gauge({ title, subtitle, score, cls, zones, trend, coverage, testid, capped }: {
  title: string; subtitle: string; score: number | null; cls: string; zones: [number, string][]; capped?: string | null;
  trend: { now: number | null; m15: number | null; m30: number | null } | null | undefined; coverage: number; testid: string;
}) {
  const move = score != null && trend?.m15 != null ? score - trend.m15 : null;
  const pos = (v: number) => `${Math.max(0, Math.min(100, v))}%`;
  return (
    <div className="rounded-xl border border-rule bg-ink/40 p-4" data-testid={testid}>
      <div className="flex items-start justify-between gap-2">
        <div><div className="text-sm font-semibold text-paper">{title}</div><div className="text-xs leading-snug text-muted">{subtitle}</div></div>
        {move != null && Math.abs(move) >= 0.5 && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${move > 0 ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>{move > 0 ? "▲" : "▼"} {Math.abs(move).toFixed(0)} vs 15 min ago</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2"><span className="num text-4xl font-bold text-paper" data-testid={`${testid}-score`}>{score == null ? MISSING : score.toFixed(0)}</span><span className="text-sm text-muted">/ 100</span><span className="ml-1 text-base font-semibold text-paper">{cls}</span></div>
      <div className="relative mt-3" aria-label={`${title} score ${score == null ? "unavailable" : score.toFixed(0)} of 100`}>
        <div className="flex h-3 overflow-hidden rounded-full">
          {zones.map(([lo, name], i) => <div key={name} className={ZONE_BG[i]} style={{ width: `${(i + 1 < zones.length ? zones[i + 1]![0] : 100) - lo}%` }} title={`${name}: ${lo}+`} />)}
        </div>
        {trend?.m15 != null && <span className="absolute -top-1 h-5 w-0.5 rounded bg-paper/50" style={{ left: pos(trend.m15) }} title={`15 minutes ago: ${trend.m15.toFixed(0)}`} />}
        {score != null && <span className="absolute -top-1.5 grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full border-2 border-paper bg-ink text-[9px] font-bold text-paper" style={{ left: pos(score) }}>●</span>}
        <div className="mt-1 flex justify-between text-[10px] text-muted">{zones.map(([lo, name]) => <span key={name} className="text-center" style={{ width: 0, flex: "1 1 0" }}>{name.replace(" environment", "")}<br /><span className="num opacity-70">{lo}+</span></span>)}</div>
      </div>
      {capped && <p className="mt-2 rounded-md bg-warn/10 px-2 py-1 text-xs leading-snug text-paper" data-testid={`${testid}-cap`}>The score sits in a higher zone, but the label is held at <b>{capped}</b> because a risk flag is active (see the flags in section 3 below).</p>}
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
export function StraddleGlance({ d, mode, setMode }: { d: StraddleDecay; mode: Mode; setMode: (m: Mode) => void }) {
  const c = useChartColors();
  const tr = d.tracker, env = d.environment;
  const times = useMemo(() => (d.times ?? []).map((t) => new Date(t).getTime()), [d.times]);
  const lot = [d.attribution?.fixed.open, d.attribution?.fixed["60"], d.attribution?.fixed["30"], d.attribution?.rolling.open, d.attribution?.rolling["60"], d.attribution?.rolling["30"]].map((w) => w?.efficiency.lot_size).find((x) => x != null);

  const change = useMemo(() => {
    if (!d.series || !d.cumulative) return null;
    const fx = d.series.fixed.straddle;
    const base = fx.find((v) => v != null);
    if (base == null) return null;
    const lines: Line[] = [
      { name: "Fixed straddle (sold at the open)", color: c.brass, data: fx.map((v) => (v == null ? null : Math.round((v - base) * 100) / 100)), fmt: (v) => sg(v) },
      { name: "Rolling ATM (roll-adjusted)", color: c.info, data: d.cumulative.rolling.actual, fmt: (v) => sg(v) },
    ];
    if (d.spot) lines.push({ name: "NIFTY (right axis)", color: c.muted, data: d.spot, axis: 1, dotted: true, fmt: (v) => v.toLocaleString("en-IN") });
    return timeLinesOption(times, lines, c, null, { leftFmt: (v) => sg(v, 0), rightFmt: (v) => v.toLocaleString("en-IN"), zeroLine: true });
  }, [d, times, c]);

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
        { name: "Fixed", type: "bar", barMaxWidth: 14, itemStyle: { color: c.brass }, data: TERM_LABEL.map(([k]) => termValue(f, k)) },
        { name: "Rolling ATM", type: "bar", barMaxWidth: 14, itemStyle: { color: c.info }, data: TERM_LABEL.map(([k]) => termValue(r, k)) },
      ],
    } as EChartsCoreOption;
  }, [d, c]);

  const kept = useMemo(() => {
    const ce = tr?.fixed.ce, pe = tr?.fixed.pe;
    if (!ce?.open || !pe?.open || ce.current == null || pe.current == null) return null;
    const v = [Math.round((ce.current / ce.open) * 1000) / 10, Math.round((pe.current / pe.open) * 1000) / 10];
    return {
      animation: false, grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
      tooltip: { show: false },
      xAxis: { type: "value", max: Math.max(150, Math.ceil(Math.max(...v) / 10) * 10), axisLabel: { color: c.muted, fontSize: 11, formatter: (x: number) => `${x}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      yAxis: { type: "category", inverse: true, data: ["Call (CE)", "Put (PE)"], axisLabel: { color: c.paper, fontSize: 12 }, axisTick: { show: false } },
      series: [{ type: "bar", barMaxWidth: 22, data: v.map((x, i) => ({ value: x, itemStyle: { color: i === 0 ? c.up : c.down, borderRadius: 3 } })), label: { show: true, position: "right", color: c.paper, fontSize: 12, formatter: (p: { value: number }) => `${p.value}%` },
        markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: c.muted, type: "dashed" }, data: [{ xAxis: 100 }] } }],
    } as EChartsCoreOption;
  }, [tr, c]);

  const hist = useMemo(() => {
    const h = d.history;
    if (!h) return null;
    const ht = (h.times ?? []).map((t) => new Date(t).getTime());
    const hs = [...h.seller], hb = [...h.buyer];
    // current reading as the last point, so the chart and the gauges agree
    const nowMs = d.generated_at ? new Date(d.generated_at).getTime() : NaN;
    if (env && Number.isFinite(nowMs) && ht.length > 0 && nowMs > (ht[ht.length - 1] as number)) { ht.push(nowMs); hs.push(env.seller.score); hb.push(env.buyer.score); }
    if (ht.length < 2) return null;
    const f = (v: number) => v.toFixed(0);
    return timeLinesOption(ht, [{ name: "Seller environment", color: c.up, data: hs, fmt: f }, { name: "Buyer environment", color: c.brass, data: hb, fmt: f }], c, null, { leftFmt: f });
  }, [d, env, c]);

  const fixedChg = tr?.fixed.straddle.change ?? null;
  const rollChg = tr?.rolling.adjusted_change ?? null;
  const sellerPnl = (pts: number | null) => (pts == null || lot == null ? null : -pts * lot);
  const sellerNote = (pts: number | null) => {
    const p = sellerPnl(pts);
    return p == null ? "" : ` A seller who sold it at the open ${p >= 0 ? "is ahead by" : "is behind by"} about ${inr(Math.abs(p)).slice(1)} per lot, before costs.`;
  };

  return (
    <div className="mt-3 space-y-3" data-testid="sdi-glance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-paper">Today at a glance</h3>
        <nav aria-label="Jump to a section" className="flex flex-wrap gap-1 text-xs">
          {[["sdi-glance-compare", "Fixed vs rolling"], ["sdi-glance-why", "Why these scores"], ["sdi-glance-sources", "What moved the premium"], ["sdi-tracker", "Details"]].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full border border-rule px-2.5 py-1 text-muted hover:text-paper">{label}</a>
          ))}
        </nav>
      </div>

      {env ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Gauge testid="sdi-gauge-seller" title="Seller environment" subtitle="Is it a good time to SELL option premium (straddles, strangles)?" score={env.seller.score} cls={env.seller.class} zones={SELLER_ZONES} capped={env.seller.capped_by_flags} trend={d.environment_trend?.seller} coverage={env.seller.coverage} />
          <Gauge testid="sdi-gauge-buyer" title="Buyer environment" subtitle="Is it a good time to BUY options (calls, puts, long straddles)?" score={env.buyer.score} cls={env.buyer.class} zones={BUYER_ZONES} trend={d.environment_trend?.buyer} coverage={env.buyer.coverage} />
        </div>
      ) : <p className="rounded-xl border border-rule bg-ink/40 p-3 text-sm text-muted">{d.environment_note ?? "No environment is available."}</p>}
      {env && <p className="rounded-xl border border-rule bg-ink/40 p-3 text-sm leading-relaxed text-paper" data-testid="sdi-glance-verdict"><span className="font-semibold">In plain words: </span>{env.comparison.text}</p>}

      {tr && (
        <section id="sdi-glance-compare" aria-label="Fixed against rolling" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-compare">
          <h4 className="text-sm font-semibold text-paper">Fixed against rolling: two ways to follow a straddle</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted">This comparison always shows both. The Fixed / Rolling buttons only choose which one the detailed sections further down use.</p>
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
          {change && <div className="mt-3"><div className="mb-1 text-xs text-muted">Change in premium since the open, in points (below zero = premium has decayed; NIFTY on the right axis)</div><div className="h-[220px]"><EChart group="sdi" option={change} ariaLabel="Change in straddle premium since the open: fixed against rolling" /></div></div>}
          {kept && <div className="mt-3"><div className="mb-1 text-xs text-muted">How much of its opening price each side of the fixed {tr.fixed.strike} straddle still has (the dashed line is 100%, the opening price; above it = more expensive now)</div><div className="h-[96px]"><EChart option={kept} ariaLabel="Share of the opening price kept by the call and the put" /></div></div>}
        </section>
      )}

      {env && (
        <section id="sdi-glance-why" aria-label="Why these scores" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-why">
          <h4 className="text-sm font-semibold text-paper">Why these scores</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted">Each bar is one piece of evidence, in points above or below a neutral 50. Green pushes the score up, red pulls it down. Touch a bar for the reason.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div><div className="text-xs font-semibold text-paper">Seller score {env.seller.score == null ? "" : env.seller.score.toFixed(0)}</div><div className="mt-1" style={{ height: 28 + 26 * env.seller.components.filter((x) => x.contribution != null).length }}><EChart option={driversOption(env.seller.components, c, c.up)} ariaLabel="What moves the seller score" /></div></div>
            <div><div className="text-xs font-semibold text-paper">Buyer score {env.buyer.score == null ? "" : env.buyer.score.toFixed(0)}</div><div className="mt-1" style={{ height: 28 + 26 * env.buyer.components.filter((x) => x.contribution != null).length }}><EChart option={driversOption(env.buyer.components, c, c.brass)} ariaLabel="What moves the buyer score" /></div></div>
          </div>
        </section>
      )}

      {sources && (
        <section id="sdi-glance-sources" aria-label="What moved the premium" className="scroll-mt-16 rounded-xl border border-rule bg-ink/40 p-3" data-testid="sdi-sources-chart">
          <h4 className="text-sm font-semibold text-paper">What moved the premium since the open</h4>
          <p className="mt-1 text-xs leading-relaxed text-muted">Points of premium added (+) or taken away (−) by each cause, for both ways of following the straddle. Time passing should take premium away; NIFTY moving and volatility rising add it back.</p>
          <div className="mt-2 h-[250px]"><EChart option={sources} ariaLabel="Causes of the premium change since the open, fixed against rolling" /></div>
        </section>
      )}

      {hist && (
        <section aria-label="Score history" className="rounded-xl border border-rule bg-ink/40 p-3">
          <h4 className="text-sm font-semibold text-paper">How the scores moved today</h4>
          <div className="mt-1 h-[190px]"><EChart group="sdi" option={hist} ariaLabel="Seller and buyer environment score history" /></div>
          <p className="text-[11px] text-muted" data-testid="sdi-hist-note">One recorded reading per minute; the last point is the current reading shown in the gauges above.</p>
        </section>
      )}

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
    </div>
  );
}

