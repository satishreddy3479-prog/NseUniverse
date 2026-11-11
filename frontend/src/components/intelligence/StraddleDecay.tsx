import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtTimeIST, MISSING } from "../../lib/format";
import { rupee, timeLinesOption, type Line } from "../../lib/priceCharts";
import type { AlertRow, Component, EnvBucket, Moves, Stat, StraddleDecay, Terms, Window, Windows } from "../../lib/straddleDecay";
import { EChart, useChartColors } from "../EChart";
import { pill } from "../dashboard/PriceBoards";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const n1 = (v: number | null | undefined, d = 1) => (v == null ? MISSING : v.toFixed(d));
const STATUS: Record<string, { text: string; tone: string }> = {
  efficient: { text: "Efficient decay", tone: "text-up" }, slower: { text: "Slower than expected", tone: "text-warn" },
  none: { text: "No meaningful decay", tone: "text-warn" }, expansion: { text: "Premium expansion", tone: "text-down" }, unavailable: { text: "Not computable", tone: "text-muted" },
};
const CLIMATE: Record<string, string> = { favourable: "text-up", mixed: "text-warn", unfavourable: "text-down", unknown: "text-muted" };
const WINDOW_LABEL: Record<string, string> = { open: "Since open", "60": "Last 60 min", "30": "Last 30 min" };
const SELLER_TONE: Record<string, string> = { "Highly favourable": "text-up", Favourable: "text-up", Neutral: "text-warn", Unfavourable: "text-down", "High risk": "text-down" };
const BUYER_TONE: Record<string, string> = { "Strong buyer environment": "text-up", Favourable: "text-up", Selective: "text-warn", Neutral: "text-muted", Unfavourable: "text-down" };
const STATE_TONE: Record<string, string> = { AVAILABLE: "text-up", PARTIAL: "text-warn", UNAVAILABLE: "text-down" };
const tone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-up" : "text-down");
const MOVE_KEYS = ["5", "15", "30", "60"] as const;

function Tile({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="min-w-0 rounded-sm bg-slate-2 px-2.5 py-2" data-testid="sdi-tile"><div className="truncate text-[11px] text-muted">{label}</div><div className={`num truncate text-[15px] font-semibold ${t ?? "text-paper"}`}>{value}</div>{sub && <div className="truncate text-[10px] text-muted">{sub}</div>}</div>;
}
function Box({ title, note, children, id, foot }: { title: string; note?: string; children: React.ReactNode; id: string; foot?: string }) {
  return <section aria-label={title} className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid={id}><h3 className="mb-2 text-sm font-semibold text-paper">{title}{note && <span className="font-normal text-muted"> · {note}</span>}</h3>{children}{foot && <p className="mt-2 text-[10px] text-muted" data-testid={`${id}-source`}>{foot}</p>}</section>;
}
function MoveRow({ label, m, d = 2 }: { label: string; m: Moves | undefined; d?: number }) {
  return <tr className="border-t border-rule/50"><td className="py-1 text-paper">{label}</td>{MOVE_KEYS.map((k) => <td key={k} className={`num py-1 text-right ${tone(m?.[k])}`}>{sg(m?.[k], d)}</td>)}</tr>;
}
function StatRow({ label, s, d = 2, unit = "" }: { label: string; s: Stat | undefined; d?: number; unit?: string }) {
  if (!s) return null;
  return <tr className="border-t border-rule/50"><td className="py-1 text-paper">{label}</td><td className="num py-1 text-right">{n1(s.open, d)}{unit}</td><td className="num py-1 text-right">{n1(s.current, d)}{unit}</td><td className={`num py-1 text-right ${tone(s.change)}`}>{sg(s.change, d)}{s.change == null ? "" : unit}</td><td className={`num py-1 text-right ${tone(s.change_pct)}`}>{s.change_pct == null ? MISSING : `${sg(s.change_pct, 1)}%`}</td></tr>;
}
function ComponentTable({ items, label }: { items: Component[]; label: string }) {
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-xs" data-testid="sdi-components" aria-label={label}>
      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Component</th><th className="py-1 text-right font-normal">Weight</th><th className="py-1 text-right font-normal">Reading (−1…+1)</th><th className="py-1 text-right font-normal">Points from 50</th><th className="py-1 pl-3 font-normal">Why · source</th></tr></thead>
      <tbody>{items.map((c) => <tr key={c.id} className="border-t border-rule/50 align-top" data-testid={`sdi-comp-${c.id}`}><td className="py-1 text-paper">{c.name}{c.proxy && <span className="ml-1 rounded-sm bg-warn/15 px-1 text-[9px] text-warn">PROXY</span>}</td><td className="num py-1 text-right">{c.weight}</td><td className={`num py-1 text-right ${tone(c.value)}`}>{c.value == null ? MISSING : sg(c.value, 2)}</td><td className={`num py-1 text-right ${tone(c.contribution)}`}>{c.contribution == null ? MISSING : sg(c.contribution, 1)}</td><td className="py-1 pl-3 text-muted">{c.text} <span className="text-[10px]">· {c.source}</span></td></tr>)}</tbody>
    </table></div>
  );
}
function Attribution({ w, label }: { w: Window; label: string }) {
  const rows: [string, Terms][] = [["Call (CE)", w.ce], ["Put (PE)", w.pe], ["Straddle (CE + PE)", w.both]];
  const cols: (keyof Terms)[] = ["theta", "vega", "delta", "gamma", "vanna", "volga", "residual", "actual"];
  const head: Record<string, string> = { theta: "Theta (time)", vega: "Vega (IV)", delta: "Delta", gamma: "Gamma", vanna: "Vanna", volga: "Volga", residual: "Residual", actual: "Actual change" };
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-xs" data-testid="sdi-attr" aria-label={`Premium change attribution, ${label}`}>
      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Points of premium, {label}</th>{cols.map((c) => <th key={c} className="py-1 text-right font-normal">{head[c]}</th>)}</tr></thead>
      <tbody>{rows.map(([n, t]) => <tr key={n} className={`border-t border-rule/50 ${n.startsWith("Straddle") ? "font-semibold" : ""}`}><td className="py-1 text-paper">{n}</td>{cols.map((c) => <td key={c} className={`num py-1 text-right ${c === "residual" ? "text-muted" : tone(t[c])}`}>{sg(t[c], 2)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
function Score({ title, score, cls, toneCls, sub, id }: { title: string; score: number | null; cls: string; toneCls: string; sub?: string; id: string }) {
  return (
    <div className="rounded-sm bg-slate-2 p-3" data-testid={id}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{title}</div>
      <div className="flex items-baseline gap-2"><span className={`num text-3xl font-semibold ${toneCls}`} data-testid={`${id}-score`}>{score == null ? MISSING : Math.round(score)}</span><span className="text-sm text-muted">/ 100</span><span className={`text-sm font-semibold ${toneCls}`}>{cls}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-rule"><div className={`h-full ${toneCls === "text-up" ? "bg-up" : toneCls === "text-down" ? "bg-down" : "bg-brass"}`} style={{ width: `${score ?? 0}%` }} /></div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
const fmtSrc = (d: StraddleDecay) => `Source: stored chain samples and Market Intelligence · last sample ${d.quality ? fmtTimeIST(d.quality.last_sample_at) : MISSING}${d.quality?.age_minutes == null ? "" : ` (${d.quality.age_minutes.toFixed(0)} min ago)`} · last traded prices, model IV and Greeks`;

/** Compact card for the Market Intelligence page: the two scores and the verdict, with a link to the full page. */
export function StraddleSummaryCard() {
  const q = useQuery({ queryKey: ["straddle-decay"], queryFn: () => api.straddleDecay(), refetchInterval: 30_000, retry: false });
  const d = q.data;
  const e = d?.environment;
  return (
    <section aria-label="Straddle decay intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="sdi-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Straddle decay and buyer/seller environments <span className="font-normal text-muted">· separate from the sentiment score</span></h2>
        <Link to="/market-intelligence/straddle" className="text-xs text-info hover:underline">Open the full analysis →</Link>
      </div>
      {q.isPending ? <p className="mt-2 text-xs text-muted">Loading…</p> : q.isError || !d ? <p role="alert" className="mt-2 text-xs text-down">Could not be loaded.</p> : !e ? <p className="mt-2 text-xs text-muted" data-testid="sdi-card-empty">{d.status !== "ok" ? d.message : d.environment_note ?? "No environment is available."}</p> : (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Score id="sdi-card-seller" title="Seller environment" score={e.seller.score} cls={e.seller.class} toneCls={SELLER_TONE[e.seller.class] ?? "text-muted"} />
          <Score id="sdi-card-buyer" title="Buyer environment" score={e.buyer.score} cls={e.buyer.class} toneCls={BUYER_TONE[e.buyer.class] ?? "text-muted"} />
          <div className="rounded-sm bg-slate-2 p-3 text-sm text-paper"><div className="text-[11px] uppercase tracking-wide text-muted">Reading</div>{e.comparison.text}</div>
        </div>
      )}
    </section>
  );
}

/** Straddle decay intelligence in the order of the brief: overall, buyer, seller, tracker, IV and skew, attribution, IV vs realised, gamma, positioning, alerts, validation, methodology. */
export function StraddleDecayPanel() {
  const c = useChartColors();
  const q = useQuery({ queryKey: ["straddle-decay"], queryFn: () => api.straddleDecay(), refetchInterval: 30_000, retry: false });
  const [mode, setMode] = useState<"fixed" | "rolling">("fixed");
  const [win, setWin] = useState<keyof Windows>("open");
  const [wantVal, setWantVal] = useState(false);
  const val = useQuery({ queryKey: ["straddle-validation"], queryFn: () => api.straddleValidation(), enabled: wantVal, retry: false, staleTime: 600_000 });
  const d: StraddleDecay | undefined = q.data;
  const times = useMemo(() => (d?.times ?? []).map((t) => new Date(t).getTime()), [d?.times]);
  const charts = useMemo(() => {
    if (!d || d.status !== "ok" || !d.series || !d.cumulative) return null;
    const sr = d.series[mode], cm = d.cumulative[mode];
    const f = (v: number) => sg(v, 1), pc = (v: number) => `${v.toFixed(2)}%`;
    const prem: Line[] = [{ name: "Straddle", color: c.brass, data: sr.straddle, fmt: rupee }, { name: "Call", color: c.up, data: sr.ce, fmt: rupee, dotted: true }, { name: "Put", color: c.down, data: sr.pe, fmt: rupee, dotted: true }];
    const att: Line[] = [
      { name: "Actual change", color: c.paper, data: cm.actual, fmt: f }, { name: "Theta", color: c.info, data: cm.theta, fmt: f, dotted: true }, { name: "Vega", color: c.up, data: cm.vega, fmt: f, dotted: true },
      { name: "Gamma", color: c.down, data: cm.gamma, fmt: f, dotted: true }, { name: "Delta", color: c.muted, data: cm.delta, fmt: f, dotted: true },
    ];
    const iv: Line[] = [{ name: "Call IV", color: c.up, data: sr.ce_iv, fmt: pc }, { name: "Put IV", color: c.down, data: sr.pe_iv, fmt: pc }, { name: "Combined", color: c.brass, data: sr.iv, fmt: pc, dotted: true }];
    const h = d.history;
    const ht = (h?.times ?? []).map((t) => new Date(t).getTime());
    const hist: Line[] = h ? [{ name: "Seller", color: c.up, data: h.seller, fmt: (v: number) => v.toFixed(0) }, { name: "Buyer", color: c.brass, data: h.buyer, fmt: (v: number) => v.toFixed(0) }] : [];
    return {
      prem: timeLinesOption(times, prem, c, null, { leftFmt: rupee }), att: timeLinesOption(times, att, c, null, { leftFmt: f, zeroLine: true }), iv: timeLinesOption(times, iv, c, null, { leftFmt: (v) => `${v.toFixed(1)}%` }),
      hist: h && ht.length > 1 ? timeLinesOption(ht, hist, c, null, { leftFmt: (v) => v.toFixed(0) }) : null,
    };
  }, [d, mode, times, c]);

  if (q.isPending) return <section aria-label="Straddle decay intelligence" className="h-24 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="sdi-loading" />;
  if (q.isError || !d) return <section aria-label="Straddle decay intelligence" role="alert" className="rounded-[var(--radius-panel)] border border-down/50 bg-slate p-4 text-sm text-down" data-testid="sdi-error">Straddle decay intelligence could not be loaded: {q.error instanceof Error ? q.error.message : "no answer"}.</section>;
  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold text-paper">Straddle decay intelligence <span className="font-normal text-muted">· separate from the sentiment score, descriptive only, not a trading signal</span></h2>
      {d.session && <span className="text-xs text-muted">Session {d.session} · expiry {d.expiry}{d.expiry_day ? " (expiry day)" : ""}</span>}
    </div>
  );
  if (d.status !== "ok" || !d.tracker || !d.iv || !d.attribution || !d.realised_vs_implied || !d.structure || !d.quality) {
    return <section aria-label="Straddle decay intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="sdi-panel">{head}<p className="mt-2 text-sm text-muted" data-testid="sdi-empty">{d.message ?? "Not enough stored data."}</p></section>;
  }
  const tr = d.tracker, iv = d.iv, rv = d.realised_vs_implied, st = d.structure, ql = d.quality, env = d.environment, ctx = d.context;
  const pos = mode === "fixed" ? tr.fixed : tr.rolling;
  const w = d.attribution[mode][win];
  const eff = w?.efficiency;
  const es = (eff ? STATUS[eff.status] : undefined) ?? STATUS.unavailable!;
  const ivv = iv[mode];
  const src = fmtSrc(d);
  return (
    <section aria-label="Straddle decay intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="sdi-panel">
      {head}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted">Position</span>
        <button type="button" aria-pressed={mode === "fixed"} onClick={() => setMode("fixed")} className={pill(mode === "fixed")} title="The strike that was ATM at the first usable sample, held all session">Fixed {tr.fixed.strike}</button>
        <button type="button" aria-pressed={mode === "rolling"} onClick={() => setMode("rolling")} className={pill(mode === "rolling")} title="The ATM strike at each step; only same-contract changes are added, so a roll makes no jump">Rolling ATM ({tr.rolling.rolls} rolls)</button>
        <span className="ml-2 text-muted">Window</span>
        {(["open", "60", "30"] as const).map((k) => <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)} className={pill(win === k)}>{WINDOW_LABEL[k]}</button>)}
        {ql.stale && <span className="ml-2 rounded-sm bg-warn/15 px-1.5 py-0.5 text-warn" data-testid="sdi-stale">Stale: last sample {n1(ql.age_minutes, 0)} min ago</span>}
        {!ql.live && <span className="ml-2 text-muted">Stored session (not live)</span>}
      </div>

      {/* 1. Overall */}
      <div className="mt-3 rounded-sm border border-rule p-3" data-testid="sdi-overall">
        <h3 className="mb-2 text-sm font-semibold text-paper">1. Overall straddle intelligence</h3>
        {env ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <Score id="sdi-seller-top" title="Seller environment" score={env.seller.score} cls={env.seller.class} toneCls={SELLER_TONE[env.seller.class] ?? "text-muted"} sub={d.environment_trend ? `15 min ago ${n1(d.environment_trend.seller.m15, 0)} · 30 min ago ${n1(d.environment_trend.seller.m30, 0)}` : "history builds as minutes are recorded"} />
              <Score id="sdi-buyer-top" title="Buyer environment" score={env.buyer.score} cls={env.buyer.class} toneCls={BUYER_TONE[env.buyer.class] ?? "text-muted"} sub={d.environment_trend ? `15 min ago ${n1(d.environment_trend.buyer.m15, 0)} · 30 min ago ${n1(d.environment_trend.buyer.m30, 0)}` : "history builds as minutes are recorded"} />
            </div>
            <p className="mt-2 text-sm text-paper" data-testid="sdi-verdict"><span className="font-semibold">Interpretation:</span> {env.comparison.text}</p>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <div><div className="text-[11px] text-muted">Evidence behind the seller score</div><ul className="list-disc pl-5 text-xs text-paper">{env.comparison.top_seller.map((x) => <li key={x.name}><span className="text-muted">{x.name} ({sg(x.contribution, 1)}):</span> {x.text}</li>)}</ul></div>
              <div><div className="text-[11px] text-muted">Evidence behind the buyer score</div><ul className="list-disc pl-5 text-xs text-paper">{env.comparison.top_buyer.map((x) => <li key={x.name}><span className="text-muted">{x.name} ({sg(x.contribution, 1)}):</span> {x.text}</li>)}</ul></div>
            </div>
            {(env.comparison.same_sign_in_both.length > 0 || env.comparison.conflicting_seller.length + env.comparison.conflicting_buyer.length > 0) && (
              <p className="mt-2 text-xs text-muted" data-testid="sdi-conflicts">Conflicting evidence: {env.comparison.conflicting_seller.length > 0 && <>against sellers: {env.comparison.conflicting_seller.join(", ")}. </>}{env.comparison.conflicting_buyer.length > 0 && <>against buyers: {env.comparison.conflicting_buyer.join(", ")}. </>}{env.comparison.same_sign_in_both.length > 0 && <>Supporting both: {env.comparison.same_sign_in_both.join(", ")}.</>}</p>
            )}
            <div className="mt-2"><div className="text-[11px] text-muted">What could invalidate it</div><ul className="list-disc pl-5 text-xs text-paper" data-testid="sdi-invalidation">{env.invalidation.map((x) => <li key={x}>{x}</li>)}</ul></div>
            {charts?.hist && <div className="mt-2 h-[180px]"><EChart group="sdi" option={charts.hist} ariaLabel="Seller and buyer environment score history" /></div>}
            <p className="mt-1 text-[11px] text-muted">{env.weights_note}</p>
          </>
        ) : <p className="text-sm text-muted" data-testid="sdi-env-none">{d.environment_note ?? "No environment is available."}</p>}
        {d.climate && (
          <div className="mt-3 rounded-sm bg-slate-2 p-3" data-testid="sdi-reading">
            <div className="text-sm text-paper">Premium-decay climate: <span className={`font-semibold ${CLIMATE[d.climate.label]}`} data-testid="sdi-climate">{d.climate.label}</span> <span className="text-xs text-muted">({d.climate.window}; {d.climate.because.join(", ") || "not enough data"})</span></div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-paper">{d.interpretation.map((x) => <li key={x.q}><span className="text-muted">{x.q}</span> {x.a}</li>)}</ol>
            {d.retention && <p className="mt-1 text-xs text-paper" data-testid="sdi-retention">{d.retention.text}</p>}
            <p className="mt-1 text-[11px] text-muted">{d.climate.note}</p>
          </div>
        )}
        {d.regime && <p className="mt-2 text-sm text-paper" data-testid="sdi-regime">Market regime: <span className="font-semibold">{d.regime.label}</span> <span className="text-xs text-muted">({d.regime.reasons.join("; ") || "not enough stored session"})</span></p>}
      </div>

      {/* 2 and 3. Buyer and seller */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Box title="2. Buyer environment" note={env ? `${env.buyer.class}, coverage ${(env.buyer.coverage * 100).toFixed(0)}%` : "live session only"} id="sdi-buyer" foot={env ? `Inputs: ${env.sources.buyer_inputs.join("; ")}. Weights are provisional.` : undefined}>
          {env ? (
            <>
              <div className="overflow-x-auto"><table className="w-full min-w-[22rem] text-xs" data-testid="sdi-buyer-types"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Type</th><th className="py-1 text-right font-normal">Score</th><th className="py-1 pl-3 font-normal">State</th></tr></thead>
                <tbody>{Object.entries(env.buyer.types).map(([k, t]) => <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{t.name}{k === "directional" && t.direction ? <span className="text-muted"> ({t.direction})</span> : null}</td><td className="num py-1 text-right">{t.score == null ? MISSING : t.score.toFixed(0)}</td><td className="py-1 pl-3 text-muted">{t.state}</td></tr>)}</tbody></table></div>
              <p className="mt-2 text-xs text-paper" data-testid="sdi-premium-check">{env.buyer.premium_check.text}</p>
              <p className="mt-1 text-xs text-muted">Direction of the evidence: {env.buyer.direction.label}{env.buyer.direction.value == null ? "" : ` (${sg(env.buyer.direction.value, 2)})`} — {env.buyer.direction.parts.map((p) => `${p.name} ${sg(p.value, 2)}`).join("; ") || "no directional readings"}. Pressure, not a forecast.</p>
            </>
          ) : <p className="text-sm text-muted">{d.environment_note}</p>}
        </Box>
        <Box title="3. Seller environment" note={env ? `${env.seller.class}${env.seller.capped_by_flags ? `, capped by ${env.seller.flags.length} risk flag(s)` : ""}` : "live session only"} id="sdi-seller" foot={env ? `Inputs: ${env.sources.seller_inputs.join("; ")}. A favourable environment is not a guarantee of profit.` : undefined}>
          {env ? (
            <>
              {env.seller.flags.length > 0 && <ul className="mb-2 list-disc pl-5 text-xs text-down" data-testid="sdi-flags">{env.seller.flags.map((f) => <li key={f.id}>{f.text}</li>)}</ul>}
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Short straddle" value={env.seller.short_straddle.score == null ? MISSING : `${env.seller.short_straddle.score.toFixed(0)} · ${env.seller.short_straddle.class}`} />
                <Tile label="Short strangle" value={env.seller.short_strangle.score == null ? MISSING : `${env.seller.short_strangle.score.toFixed(0)} · ${env.seller.short_strangle.class}`} />
                <Tile label="Call-side selling risk" value={env.seller.call_side_risk.risk == null ? MISSING : `${env.seller.call_side_risk.risk.toFixed(0)} · ${env.seller.call_side_risk.label}`} sub={env.seller.call_side_risk.reasons[0]?.text} />
                <Tile label="Put-side selling risk" value={env.seller.put_side_risk.risk == null ? MISSING : `${env.seller.put_side_risk.risk.toFixed(0)} · ${env.seller.put_side_risk.label}`} sub={env.seller.put_side_risk.reasons[0]?.text} />
              </div>
            </>
          ) : <p className="text-sm text-muted">{d.environment_note}</p>}
        </Box>
      </div>
      {env && (
        <details className="mt-2 rounded-sm border border-rule" data-testid="sdi-evidence"><summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-paper">Every component behind both scores (weights, readings, contributions, conflicting evidence)</summary>
          <div className="space-y-3 border-t border-rule px-3 py-2"><div><div className="mb-1 text-[11px] text-muted">Seller score components</div><ComponentTable items={env.seller.components} label="Seller score components" /></div><div><div className="mb-1 text-[11px] text-muted">Buyer score components</div><ComponentTable items={env.buyer.components} label="Buyer score components" /></div></div>
        </details>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {/* 4. Tracker */}
        <Box title="4. Straddle premium tracker" note={mode === "fixed" ? `fixed ${tr.fixed.strike}` : "rolling ATM, roll-adjusted"} id="sdi-tracker" foot={`${src} · opening = first stored sample (${fmtTimeIST(tr.opening_at)})`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile label="Opening CE" value={n1(pos.ce.open)} sub={`now ${n1(pos.ce.current)} (${sg(pos.ce.change)})`} />
            <Tile label="Opening PE" value={n1(pos.pe.open)} sub={`now ${n1(pos.pe.current)} (${sg(pos.pe.change)})`} />
            <Tile label="Opening straddle" value={n1(pos.straddle.open)} sub={`first sample ${fmtTimeIST(tr.opening_at)}`} />
            <Tile label="Straddle now" value={n1(pos.straddle.current)} sub={`high ${n1(pos.straddle.high)} · low ${n1(pos.straddle.low)}`} />
            <Tile label="Change (points)" value={sg(pos.straddle.change)} tone={tone(pos.straddle.change)} sub={mode === "rolling" ? `roll-adjusted ${sg(tr.rolling.adjusted_change)}` : undefined} />
            <Tile label="Decay (%)" value={pos.straddle.change_pct == null ? MISSING : `${sg(pos.straddle.change_pct, 2)}%`} tone={tone(pos.straddle.change_pct)} sub={`ATM strike ${tr.atm_open ?? MISSING} → ${tr.atm_now ?? MISSING}`} />
          </div>
          {tr.moves && <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[22rem] text-xs" data-testid="sdi-moves"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Premium change (points)</th>{MOVE_KEYS.map((k) => <th key={k} className="py-1 text-right font-normal">{k} min</th>)}</tr></thead>
            <tbody><MoveRow label="Fixed straddle" m={tr.moves.fixed.straddle} /><MoveRow label="Fixed call" m={tr.moves.fixed.ce} /><MoveRow label="Fixed put" m={tr.moves.fixed.pe} /><MoveRow label="Rolling, roll-adjusted" m={tr.moves.rolling_adjusted.straddle} /></tbody></table></div>}
          {tr.difference && <p className="mt-1 text-xs text-paper" data-testid="sdi-fixed-vs-rolling">Fixed minus rolling premium now: {sg(tr.difference.fixed_minus_rolling_now)} points; change since open: fixed {sg(tr.difference.fixed_change)}, rolling roll-adjusted {sg(tr.difference.rolling_adjusted_change)}. <span className="text-muted">{tr.difference.note}</span></p>}
          {charts && <div className="mt-2 h-[240px]"><EChart group="sdi" option={charts.prem} ariaLabel="Intraday premium decay: straddle, call and put" /></div>}
        </Box>

        {/* 6. Attribution */}
        <Box title="6. Theta, vega and gamma attribution and decay efficiency" note={WINDOW_LABEL[win]} id="sdi-attribution" foot="Black-76 repricing, Shapley over time, forward and implied vol, summed over one-sample steps; vanna and volga are carved out of the vol-forward cross terms; the residual is solver error, never labelled IV impact.">
          {w && eff ? (
            <>
              <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Decay efficiency" value={eff.efficiency_pct == null ? MISSING : `${eff.efficiency_pct.toFixed(0)}%`} sub="actual decay ÷ theta decay" tone={es.tone} />
                <Tile label="Class" value={es.text} tone={es.tone} />
                <Tile label="Actual decay" value={n1(eff.actual_decay)} sub="points" />
                <Tile label="Theta decay" value={n1(eff.expected_decay)} sub="points expected from time" />
              </div>
              {eff.shortfall != null && <p className="mb-1 text-xs text-paper" data-testid="sdi-shortfall">Decay shortfall: {n1(eff.shortfall)} points = ₹{eff.shortfall_rupees == null ? MISSING : eff.shortfall_rupees.toLocaleString("en-IN")} per lot of {eff.lot_size ?? 65} ({n1(eff.shortfall_pct, 0)}% of the theta decay).</p>}
              <p className="mb-2 text-xs text-paper" data-testid="sdi-reason">{eff.reason ?? "No reason available."}</p>
              {eff.causes && <ul className="mb-2 grid gap-x-4 text-xs sm:grid-cols-2" data-testid="sdi-causes">{Object.entries(eff.causes).map(([k, v]) => <li key={k} className="flex justify-between border-b border-rule/40 py-0.5"><span className="text-muted">{k}</span><span className={`num ${tone(v)}`}>{sg(v, 2)}</span></li>)}</ul>}
              <Attribution w={w} label={WINDOW_LABEL[win]!} />
              <p className="mt-1 text-[11px] text-muted">{w.steps} steps. Of the vega, the part from the call and put vols moving by different amounts (skew): {sg(w.both.vega_skew, 2)} points.</p>
            </>
          ) : <p className="text-sm text-muted" data-testid="sdi-nowindow">{WINDOW_LABEL[win]} needs that much stored session first (or too many prices are missing); nothing is filled in.</p>}
          {charts && <div className="mt-2 h-[220px]"><EChart group="sdi" option={charts.att} ariaLabel="Cumulative premium change split into theta, vega, delta and gamma" /></div>}
        </Box>

        {/* 5. IV and skew */}
        <Box title="5. IV and skew analysis" note={mode === "fixed" ? `fixed ${tr.fixed.strike} legs` : "rolling ATM legs"} id="sdi-iv" foot={`Model implied vols (Black-76, forward from put-call parity, assumed rate ${((d.rate_assumed ?? 0) * 100).toFixed(1)}%). ${ctx ? `Term structure and skew cards: Market Intelligence, as of ${fmtTimeIST(ctx.as_of)}.` : ""}`}>
          <div className="overflow-x-auto"><table className="w-full min-w-[26rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Implied vol (%)</th><th className="py-1 text-right font-normal">Open</th><th className="py-1 text-right font-normal">Now</th><th className="py-1 text-right font-normal">Change (pts)</th><th className="py-1 text-right font-normal">Change (%)</th></tr></thead>
            <tbody><StatRow label="Call IV" s={ivv.ce} /><StatRow label="Put IV" s={ivv.pe} /><StatRow label="Combined ATM IV" s={ivv.combined} />
              <StatRow label="25Δ put IV" s={iv.levels?.pe25} /><StatRow label="25Δ call IV" s={iv.levels?.ce25} /><StatRow label="10Δ put IV" s={iv.levels?.pe10} /><StatRow label="10Δ call IV" s={iv.levels?.ce10} />
              <StatRow label="25Δ skew (put − call)" s={iv.skew25} /><StatRow label="10Δ skew (put − call)" s={iv.skew10} /><StatRow label="25Δ risk reversal (call − put)" s={iv.rr25} /><StatRow label="10Δ risk reversal (call − put)" s={iv.rr10} />
              <StatRow label="25Δ butterfly" s={iv.levels?.butterfly25} /><StatRow label="10Δ butterfly" s={iv.levels?.butterfly10} /></tbody></table></div>
          {iv.moves && <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[22rem] text-xs" data-testid="sdi-iv-moves"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">IV change (vol points)</th>{MOVE_KEYS.map((k) => <th key={k} className="py-1 text-right font-normal">{k} min</th>)}</tr></thead>
            <tbody><MoveRow label="Call IV (fixed strike)" m={iv.moves.fixed_ce} /><MoveRow label="Put IV (fixed strike)" m={iv.moves.fixed_pe} /><MoveRow label="ATM IV (rolling)" m={iv.moves.rolling_atm} /><MoveRow label="25Δ skew" m={iv.moves.skew25} /></tbody></table></div>}
          {iv.regimes && <ul className="mt-2 space-y-1 text-xs text-paper" data-testid="sdi-iv-regimes">{(["30", "60", "open"] as const).map((k) => <li key={k}><span className="text-muted">{k === "open" ? "Since open" : `${k} min`}:</span> {iv.regimes?.[k].text}</li>)}</ul>}
          <p className="mt-2 text-xs text-paper" data-testid="sdi-support">{iv.support.text}</p>
          <p className="mt-1 text-xs text-muted">IV change relative to NIFTY: {iv.per_spot_pct == null ? "not defined (spot has moved less than 0.1% since the open)" : `${sg(iv.per_spot_pct, 2)} vol points per 1% spot move since open`}; {iv.iv_vs_spot.slope_pts_per_pct == null ? `intraday slope needs at least 20 pairs (have ${iv.iv_vs_spot.pairs})` : `intraday slope ${sg(iv.iv_vs_spot.slope_pts_per_pct, 2)} points per 1% (corr ${n1(iv.iv_vs_spot.corr, 2)})`}.</p>
          {ctx?.volatility.term && ctx.volatility.term.length > 0 ? (
            <div className="mt-2" data-testid="sdi-term"><div className="text-[11px] text-muted">IV term structure ({ctx.volatility.term_shape ?? "shape unavailable"}, slope {n1(ctx.volatility.term_slope_30d)} per 30 days)</div>
              <div className="flex flex-wrap gap-2 text-xs">{ctx.volatility.term.map((t) => <span key={t.expiry} className="rounded-sm bg-slate-2 px-2 py-1"><span className="text-muted">{t.expiry} ({t.days ?? MISSING}d)</span> <span className="num">{n1(t.atm_iv)}%</span></span>)}</div></div>
          ) : <p className="mt-2 text-xs text-muted" data-testid="sdi-term">IV term structure: UNAVAILABLE (needs more than one stored expiry).</p>}
          {charts && <div className="mt-2 h-[200px]"><EChart group="sdi" option={charts.iv} ariaLabel="Call, put and combined implied volatility" /></div>}
        </Box>

        {/* 7 and 8 */}
        <div className="flex flex-col gap-3">
          <Box title="7. Implied vs realised volatility" id="sdi-rv" foot="Realised: log returns of stored spot, annualised on trading minutes (375 × 252). Implied: quoted ATM IV on calendar time. Gaps over 10 minutes are skipped, windows under 80% covered are unavailable.">
            <div className="overflow-x-auto"><table className="w-full min-w-[22rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window</th><th className="py-1 text-right font-normal">Realised vol</th><th className="py-1 text-right font-normal">Implied (now)</th><th className="py-1 text-right font-normal">IV − RV</th></tr></thead>
              <tbody>{["5", "15", "30", "60", "open"].map((k) => { const r = rv.windows[k]; return <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{k === "open" ? "Since open" : `${k} min`}</td><td className="num py-1 text-right" title={r?.note}>{r?.vol_pct == null ? MISSING : `${r.vol_pct.toFixed(1)}%`}</td><td className="num py-1 text-right">{n1(rv.iv_now)}%</td><td className={`num py-1 text-right ${tone(rv.gap[k])}`}>{sg(rv.gap[k])}</td></tr>; })}</tbody></table></div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="ATM IV open → now" value={`${n1(rv.iv_open)} → ${n1(rv.iv_now)}`} sub={rv.iv_state ? `IV ${rv.iv_state}` : undefined} />
              <Tile label="Implied move" value={`${n1(rv.implied_move_pts)} pts`} sub={rv.implied_move_pct == null ? undefined : `${rv.implied_move_pct.toFixed(2)}% (straddle)`} />
              <Tile label="Implied 1-day SD" value={`${n1(rv.implied_daily_sd_pts)} pts`} sub="forward × IV ÷ √252" />
              <Tile label="NIFTY move" value={`${sg(rv.actual_move_pts, 0)} pts`} sub={`range ${n1(rv.actual_range_pts, 0)}; ${rv.move_vs_daily_sd == null ? MISSING : `${rv.move_vs_daily_sd}× 1-day SD`}`} />
              <Tile label="Realised variance" value={rv.realised_variance.session_move_sd_pct == null ? MISSING : `${rv.realised_variance.session_move_sd_pct}%`} sub={`√Σ(returns²), ${rv.realised_variance.returns} returns`} />
              <Tile label="Movement" value={rv.acceleration?.label ?? MISSING} sub={rv.acceleration?.ratio == null ? "needs 30 min" : `last 15 min = ${rv.acceleration.ratio}× the 15 before`} />
            </div>
          </Box>
          <Box title="8. GEX and gamma regime" id="sdi-structure" foot={`${st.assumption ?? ""} GEX as of ${st.gex ? fmtTimeIST(st.gex.at) : MISSING}.`}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile label="Net GEX" value={st.gex?.net == null ? MISSING : st.gex.net.toFixed(2)} sub={st.gex ? `${st.gex.regime}${st.gex.relationship && st.gex.relationship !== "none" && st.gex.relationship !== "unavailable" ? `, ${st.gex.relationship}` : ""}` : "live session only"} />
              <Tile label="Gamma flip" value={st.gex?.flip == null ? MISSING : String(Math.round(st.gex.flip))} sub={st.gex?.flip_distance_pts == null ? undefined : `${sg(st.gex.flip_distance_pts, 0)} pts from spot`} />
              <Tile label="Walls (call / put)" value={`${st.gex?.call_wall ?? MISSING} / ${st.gex?.put_wall ?? MISSING}`} />
              <Tile label="Gamma near ATM" value={st.concentration?.share_pct == null ? MISSING : `${st.concentration.share_pct}%`} sub="γ × OI within 2 strikes" />
              <Tile label="Straddle theta / day" value={sg(st.straddle_theta_per_day, 1)} sub="points" />
              <Tile label="Break-even daily move" value={`${n1(st.breakeven_daily_move_pts, 0)} pts`} sub={`realised ${n1(st.realised_daily_sd_pts, 0)} pts (${st.realised_vs_breakeven == null ? MISSING : `${st.realised_vs_breakeven}×`})`} />
            </div>
            {st.gex_session && <p className="mt-2 text-xs text-paper" data-testid="sdi-gex-session">Net GEX through the session: {n1(st.gex_session.first_net, 0)} → {n1(st.gex_session.latest_net, 0)} (range {n1(st.gex_session.min_net, 0)} to {n1(st.gex_session.max_net, 0)}); spot crossed the flip {st.gex_session.flip_crossings} time(s); NIFTY {sg(st.spot_move_pts, 0)} pts since the first sample.</p>}
            {st.config && st.config.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-paper" data-testid="sdi-gamma-config">{st.config.map((x) => <li key={x.tag}><span className="font-semibold">{x.tag}:</span> <span className="text-muted">{x.why}</span></li>)}</ul>}
            <p className="mt-1 text-[11px] text-muted">{st.note}</p>
          </Box>
        </div>
      </div>

      {/* 9. Positioning */}
      <Box title="9. Options positioning" note="from Market Intelligence" id="sdi-positioning" foot={`Source: stored strike positioning, futures flow and heavyweight flow · as of ${ctx ? fmtTimeIST(ctx.as_of) : MISSING}. CVD is an estimate; OI does not identify who bought or sold.`}>
        {ctx && env ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              <Tile label="PCR (OI)" value={n1(ctx.options.pcr_oi, 2)} sub={`volume ${n1(ctx.options.pcr_vol, 2)}`} />
              <Tile label="Largest call OI" value={String(ctx.options.max_ce_oi_strike ?? MISSING)} sub={`OI change ${sg(ctx.options.ce_oi_change, 0)}`} />
              <Tile label="Largest put OI" value={String(ctx.options.max_pe_oi_strike ?? MISSING)} sub={`OI change ${sg(ctx.options.pe_oi_change, 0)}`} />
              <Tile label="Futures OI change" value={sg(ctx.futures.oi_change, 0)} sub={ctx.futures.buildup ?? undefined} />
              <Tile label="Futures vs VWAP" value={ctx.futures.vwap?.distance_pct == null ? MISSING : `${sg(ctx.futures.vwap.distance_pct, 2)}%`} sub={ctx.futures.vwap?.side ?? undefined} />
              <Tile label="Heavyweight CVD 15m" value={ctx.heavyweights.aggregate?.["15"]?.score == null ? MISSING : sg(ctx.heavyweights.aggregate["15"].score, 0)} sub={ctx.heavyweights.participation?.class} />
            </div>
            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div><div className="text-[11px] text-muted">Largest additions / unwinding (call side)</div>{[...ctx.options.largest_call_additions.map((x) => ({ ...x, k: "add" })), ...ctx.options.largest_call_unwinding.map((x) => ({ ...x, k: "unwind" }))].map((x) => <span key={`c${x.strike}${x.k}`} className="mr-2 inline-block">{x.strike} <span className={x.k === "add" ? "text-up" : "text-down"}>{sg(x.change, 0)}</span></span>)}</div>
              <div><div className="text-[11px] text-muted">Largest additions / unwinding (put side)</div>{[...ctx.options.largest_put_additions.map((x) => ({ ...x, k: "add" })), ...ctx.options.largest_put_unwinding.map((x) => ({ ...x, k: "unwind" }))].map((x) => <span key={`p${x.strike}${x.k}`} className="mr-2 inline-block">{x.strike} <span className={x.k === "add" ? "text-up" : "text-down"}>{sg(x.change, 0)}</span></span>)}</div>
            </div>
            {env.positioning && <div className="mt-2 text-xs" data-testid="sdi-pos-read"><span className={`font-semibold ${env.positioning.supports == null ? "text-muted" : env.positioning.supports ? "text-up" : "text-warn"}`}>{env.positioning.supports == null ? "Neither supports nor contradicts" : env.positioning.supports ? "Supports a premium-decay environment" : "Does not support a premium-decay environment"}</span><ul className="list-disc pl-5 text-paper">{env.positioning.lines.map((l) => <li key={l}>{l}</li>)}</ul></div>}
          </>
        ) : <p className="text-sm text-muted" data-testid="sdi-pos-none">UNAVAILABLE: positioning is read from the live Market Intelligence engines.</p>}
      </Box>

      {/* 10. Alerts */}
      <Box title="10. Live alerts" note="persistence checks and a 10 minute cooldown per kind" id="sdi-alerts" foot="Alerts describe a change in readings; none is a trade signal. Thresholds are configurable on the server.">
        {(d.alerts ?? []).length === 0 ? <p className="text-sm text-muted" data-testid="sdi-alerts-none">No alert has been raised in this session.</p> : (
          <ul className="space-y-1 text-xs" data-testid="sdi-alert-list">{(d.alerts as AlertRow[]).map((a) => <li key={a.id} className="flex flex-wrap gap-2 border-b border-rule/40 py-1"><span className="num text-muted">{fmtTimeIST(a.at)}</span><span className={`font-semibold ${a.severity === "high" ? "text-down" : "text-warn"}`}>{a.kind}</span><span className="text-paper">{a.text}</span></li>)}</ul>
        )}
      </Box>

      {/* 11. Validation */}
      <details className="mt-3 rounded-sm border border-rule" data-testid="sdi-validation" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setWantVal(true); }}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-paper">11. Historical validation: theta arithmetic and recorded environment scores</summary>
        <div className="space-y-3 border-t border-rule px-3 py-2 text-xs">
          {val.isPending && wantVal ? <p className="text-muted">Computing from stored sessions…</p> : val.isError ? <p className="text-down">Validation could not be computed.</p> : val.data ? (
            <>
              <div>
                <p className={val.data.sufficient ? "text-paper" : "text-warn"} data-testid="sdi-val-message">{val.data.message}</p>
                <p className="mt-1 text-muted">{val.data.method}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Tile label="Windows" value={String(val.data.overall.windows)} sub={`${val.data.sessions.length} sessions, ${val.data.window_minutes} min`} />
                  <Tile label="Actual ÷ predicted" value={n1(val.data.overall.ratio_actual_to_predicted, 2)} sub="1 = decay as theta alone says" />
                  <Tile label="Mean abs error" value={n1(val.data.overall.mae, 2)} sub="points per window" />
                  <Tile label="Earlier / later half" value={`${n1(val.data.earlier_half.ratio_actual_to_predicted, 2)} / ${n1(val.data.later_half.ratio_actual_to_predicted, 2)}`} sub="same ratio, chronological split" />
                </div>
              </div>
              {val.data.environment && (
                <div data-testid="sdi-env-validation">
                  <p className={val.data.environment.sufficient ? "text-paper" : "text-warn"} data-testid="sdi-env-val-message">{val.data.environment.message}</p>
                  {val.data.environment.table && (["seller", "buyer"] as const).map((kind) => (
                    <div key={kind} className="mt-2 overflow-x-auto"><table className="w-full min-w-[34rem] text-xs"><caption className="text-left text-[11px] text-muted">{kind === "seller" ? "Seller score: short ATM straddle proxy" : "Buyer score: long ATM straddle proxy and direction"}, net of assumed costs</caption>
                      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Horizon · score bucket</th><th className="py-1 text-right font-normal">n</th><th className="py-1 text-right font-normal">Mean result</th><th className="py-1 text-right font-normal">Median</th><th className="py-1 text-right font-normal">Worst adverse</th><th className="py-1 text-right font-normal">Drawdown</th><th className="py-1 text-right font-normal">{kind === "buyer" ? "Direction hit" : "Win rate"}</th></tr></thead>
                      <tbody>{Object.entries(val.data.environment?.table?.[kind] ?? {}).flatMap(([h, bs]) => Object.entries(bs).map(([b, v]) => { const x = v as EnvBucket; return <tr key={`${h}${b}`} className="border-t border-rule/50"><td className="py-1 text-paper">{h === "eos" ? "end of session" : `${h} min`} · {b}</td><td className="num py-1 text-right">{x.n}</td><td className={`num py-1 text-right ${tone(x.mean_result_pts)}`}>{sg(x.mean_result_pts, 2)}</td><td className="num py-1 text-right">{sg(x.median_result_pts, 2)}</td><td className="num py-1 text-right">{n1(x.max_adverse_pts, 2)}</td><td className="num py-1 text-right">{n1(x.max_drawdown_pts, 2)}</td><td className="num py-1 text-right">{kind === "buyer" ? (x.directional_accuracy_pct == null ? MISSING : `${x.directional_accuracy_pct}%`) : x.win_rate_pct == null ? MISSING : `${x.win_rate_pct}%`}</td></tr>; }))}</tbody></table></div>
                  ))}
                  {val.data.environment.assumptions && <p className="mt-1 text-muted">{val.data.environment.assumptions}</p>}
                  {val.data.environment.limits && <ul className="mt-1 list-disc pl-5 text-muted">{val.data.environment.limits.map((l) => <li key={l}>{l}</li>)}</ul>}
                </div>
              )}
              <p className="text-muted">{val.data.note}</p>
            </>
          ) : <p className="text-muted">Open to compute from stored sessions.</p>}
        </div>
      </details>

      {/* 12. Methodology */}
      <details className="mt-3 rounded-sm border border-rule" data-testid="sdi-method"><summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-paper">12. Calculation methodology, data sources and limitations</summary>
        <div className="space-y-2 border-t border-rule px-3 py-2 text-xs text-muted">
          <ul className="list-disc pl-5">{Object.entries(d.definitions ?? {}).map(([k, v]) => <li key={k}><span className="text-paper">{k}:</span> {v}</li>)}</ul>
          {env && <ul className="list-disc pl-5" data-testid="sdi-proxies">{env.proxies.map((p) => <li key={p}>{p}</li>)}<li>{env.weights_note}</li></ul>}
          {d.sources && <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-xs" data-testid="sdi-sources"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Input</th><th className="py-1 font-normal">Status</th><th className="py-1 font-normal">As of</th><th className="py-1 text-right font-normal">Age</th><th className="py-1 pl-3 font-normal">Reliability</th></tr></thead>
            <tbody>{d.sources.map((s) => <tr key={s.id} className="border-t border-rule/50"><td className="py-1 text-paper">{s.name}</td><td className={`py-1 font-semibold ${STATE_TONE[s.status]}`}>{s.status}</td><td className="num py-1">{s.as_of ? fmtTimeIST(s.as_of) : MISSING}</td><td className="num py-1 text-right">{s.age_s == null ? MISSING : `${s.age_s}s`}</td><td className="py-1 pl-3">{s.reliability}</td></tr>)}</tbody></table></div>}
          <p data-testid="sdi-quality">{d.proxies} Estimated: {ql.estimated.join("; ")}. {ql.steps_skipped_fixed + ql.steps_skipped_rolling > 0 ? `${ql.steps_skipped_fixed} fixed and ${ql.steps_skipped_rolling} rolling step(s) skipped for a missing price or vol (not filled). ` : ""}Last sample {fmtTimeIST(ql.last_sample_at)}; {d.samples} samples; computed in {d.compute_ms ?? MISSING} ms; {d.storage ? `${d.storage.rows_today} minutes recorded today, ${(d.storage.bytes / 1e6).toFixed(2)} MB on disk` : "recording not available"}. Opening values are the first stored sample, not the exchange open. GEX is modelled exposure, never observed dealer positioning. No score here changes the fused sentiment score.</p>
        </div>
      </details>
    </section>
  );
}
