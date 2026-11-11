import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtTimeIST, MISSING } from "../../lib/format";
import { rupee, timeLinesOption, type Line } from "../../lib/priceCharts";
import type { Stat, StraddleDecay, Terms, Window, Windows } from "../../lib/straddleDecay";
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

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="min-w-0 rounded-sm bg-slate-2 px-2.5 py-2" data-testid="sdi-tile"><div className="truncate text-[11px] text-muted">{label}</div><div className={`num truncate text-[15px] font-semibold ${tone ?? "text-paper"}`}>{value}</div>{sub && <div className="truncate text-[10px] text-muted">{sub}</div>}</div>;
}
function Box({ title, note, children, id }: { title: string; note?: string; children: React.ReactNode; id: string }) {
  return <section aria-label={title} className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid={id}><h3 className="mb-2 text-sm font-semibold text-paper">{title}{note && <span className="font-normal text-muted"> · {note}</span>}</h3>{children}</section>;
}
const tone = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-up" : "text-down");

function StatRow({ label, s, d = 2, unit = "" }: { label: string; s: Stat; d?: number; unit?: string }) {
  return <tr className="border-t border-rule/50"><td className="py-1 text-paper">{label}</td><td className="num py-1 text-right">{n1(s.open, d)}{unit}</td><td className="num py-1 text-right">{n1(s.current, d)}{unit}</td><td className={`num py-1 text-right ${tone(s.change)}`}>{sg(s.change, d)}{s.change == null ? "" : unit}</td><td className={`num py-1 text-right ${tone(s.change_pct)}`}>{s.change_pct == null ? MISSING : `${sg(s.change_pct, 1)}%`}</td></tr>;
}

function Attribution({ w, label }: { w: Window; label: string }) {
  const rows: [string, Terms][] = [["Call (CE)", w.ce], ["Put (PE)", w.pe], ["Straddle (CE + PE)", w.both]];
  const cols: (keyof Terms)[] = ["theta", "vega", "delta", "gamma", "residual", "actual"];
  const head: Record<keyof Terms, string> = { theta: "Theta (time)", vega: "Vega (IV)", delta: "Delta", gamma: "Gamma", residual: "Residual", actual: "Actual change" };
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-xs" data-testid="sdi-attr" aria-label={`Premium change attribution, ${label}`}>
      <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Points of premium, {label}</th>{cols.map((c) => <th key={c} className="py-1 text-right font-normal">{head[c]}</th>)}</tr></thead>
      <tbody>{rows.map(([n, t]) => <tr key={n} className={`border-t border-rule/50 ${n.startsWith("Straddle") ? "font-semibold" : ""}`}><td className="py-1 text-paper">{n}</td>{cols.map((c) => <td key={c} className={`num py-1 text-right ${c === "residual" ? "text-muted" : tone(t[c])}`}>{sg(t[c], 2)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

/** Straddle decay intelligence: why the ATM straddle does or does not decay. Separate from the sentiment score; see lib/straddleDecay.ts for the shapes
 *  and backend/app/intelligence/straddle.py for every definition. Descriptive: nothing here is a forecast or a trade call. */
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
    const prem: Line[] = [
      { name: "Straddle", color: c.brass, data: sr.straddle, fmt: rupee }, { name: "Call", color: c.up, data: sr.ce, fmt: rupee, dotted: true }, { name: "Put", color: c.down, data: sr.pe, fmt: rupee, dotted: true },
    ];
    const att: Line[] = [
      { name: "Actual change", color: c.paper ?? c.brass, data: cm.actual, fmt: (v: number) => sg(v, 1) }, { name: "Theta", color: c.info, data: cm.theta, fmt: (v: number) => sg(v, 1), dotted: true },
      { name: "Vega", color: c.up, data: cm.vega, fmt: (v: number) => sg(v, 1), dotted: true }, { name: "Gamma", color: c.down, data: cm.gamma, fmt: (v: number) => sg(v, 1), dotted: true },
      { name: "Delta", color: c.muted, data: cm.delta, fmt: (v: number) => sg(v, 1), dotted: true },
    ];
    const iv: Line[] = [
      { name: "Call IV", color: c.up, data: sr.ce_iv, fmt: (v: number) => `${v.toFixed(2)}%` }, { name: "Put IV", color: c.down, data: sr.pe_iv, fmt: (v: number) => `${v.toFixed(2)}%` },
      { name: "Combined", color: c.brass, data: sr.iv, fmt: (v: number) => `${v.toFixed(2)}%`, dotted: true },
    ];
    return {
      prem: timeLinesOption(times, prem, c, null, { leftFmt: rupee }), att: timeLinesOption(times, att, c, null, { leftFmt: (v) => sg(v, 1), zeroLine: true }),
      iv: timeLinesOption(times, iv, c, null, { leftFmt: (v) => `${v.toFixed(1)}%` }),
    };
  }, [d, mode, times, c]);

  if (q.isPending) return <section aria-label="Straddle decay intelligence" className="h-24 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" data-testid="sdi-loading" />;
  if (q.isError || !d) return <section aria-label="Straddle decay intelligence" role="alert" className="rounded-[var(--radius-panel)] border border-down/50 bg-slate p-4 text-sm text-down" data-testid="sdi-error">Straddle decay intelligence could not be loaded: {q.error instanceof Error ? q.error.message : "no answer"}.</section>;
  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold text-paper">Straddle decay intelligence <span className="font-normal text-muted">· separate from the sentiment score, descriptive only</span></h2>
      {d.session && <span className="text-xs text-muted">Session {d.session} · expiry {d.expiry}</span>}
    </div>
  );
  if (d.status !== "ok" || !d.tracker || !d.iv || !d.attribution || !d.realised_vs_implied || !d.structure || !d.quality) {
    return <section aria-label="Straddle decay intelligence" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="sdi-panel">{head}<p className="mt-2 text-sm text-muted" data-testid="sdi-empty">{d.message ?? "Not enough stored data."}</p></section>;
  }
  const tr = d.tracker, iv = d.iv, rv = d.realised_vs_implied, st = d.structure, ql = d.quality;
  const pos = mode === "fixed" ? tr.fixed : tr.rolling;
  const w = d.attribution[mode][win];
  const eff = w?.efficiency;
  const es = (eff ? STATUS[eff.status] : undefined) ?? STATUS.unavailable!;
  const ivv = iv[mode];
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

      {d.climate && (
        <div className="mt-3 rounded-sm bg-slate-2 p-3" data-testid="sdi-reading">
          <div className="text-sm text-paper">Premium-decay climate: <span className={`font-semibold ${CLIMATE[d.climate.label]}`} data-testid="sdi-climate">{d.climate.label}</span> <span className="text-xs text-muted">({d.climate.window}; {d.climate.because.join(", ") || "not enough data"})</span></div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-paper">{d.interpretation.map((x) => <li key={x.q}><span className="text-muted">{x.q}</span> {x.a}</li>)}</ol>
          <p className="mt-1 text-[11px] text-muted">{d.climate.note}</p>
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Box title="1. Premium tracker" note={mode === "fixed" ? `fixed ${tr.fixed.strike}` : "rolling ATM, roll-adjusted"} id="sdi-tracker">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile label="Opening CE" value={n1(pos.ce.open)} sub={`now ${n1(pos.ce.current)} (${sg(pos.ce.change)})`} />
            <Tile label="Opening PE" value={n1(pos.pe.open)} sub={`now ${n1(pos.pe.current)} (${sg(pos.pe.change)})`} />
            <Tile label="Opening straddle" value={n1(pos.straddle.open)} sub={`first sample ${fmtTimeIST(tr.opening_at)}`} />
            <Tile label="Straddle now" value={n1(pos.straddle.current)} />
            <Tile label="Change (points)" value={sg(pos.straddle.change)} tone={tone(pos.straddle.change)} sub={mode === "rolling" ? `roll-adjusted ${sg(tr.rolling.adjusted_change)}` : undefined} />
            <Tile label="Change (%)" value={pos.straddle.change_pct == null ? MISSING : `${sg(pos.straddle.change_pct, 2)}%`} tone={tone(pos.straddle.change_pct)} />
          </div>
          {charts && <div className="mt-2 h-[260px]"><EChart group="sdi" option={charts.prem} ariaLabel="Intraday premium decay: straddle, call and put" /></div>}
          <p className="mt-1 text-[11px] text-muted">Intraday premium decay timeline. Fixed and rolling are separate readings: the rolling line includes roll jumps, the roll-adjusted change does not.</p>
        </Box>

        <Box title="3 and 5. Theta, vega, gamma attribution and decay efficiency" note={WINDOW_LABEL[win]} id="sdi-attribution">
          {w && eff ? (
            <>
              <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Decay efficiency" value={eff.efficiency_pct == null ? MISSING : `${eff.efficiency_pct.toFixed(0)}%`} sub="actual decay ÷ theta decay" tone={es.tone} />
                <Tile label="Class" value={es.text} tone={es.tone} />
                <Tile label="Actual decay" value={n1(eff.actual_decay)} sub="points" />
                <Tile label="Theta decay" value={n1(eff.expected_decay)} sub="points expected from time" />
              </div>
              <p className="mb-2 text-xs text-paper" data-testid="sdi-reason">{eff.reason ?? "No reason available."}</p>
              <Attribution w={w} label={WINDOW_LABEL[win]!} />
              <p className="mt-1 text-[11px] text-muted">Black-76 repricing, Shapley over time, forward and implied vol, summed over {w.steps} one-sample steps; each leg uses its own implied vol, so the residual is solver error only, not an IV estimate.</p>
            </>
          ) : <p className="text-sm text-muted" data-testid="sdi-nowindow">{WINDOW_LABEL[win]} needs that much stored session first (or too many prices are missing); nothing is filled in.</p>}
          {charts && <div className="mt-2 h-[240px]"><EChart group="sdi" option={charts.att} ariaLabel="Cumulative premium change split into theta, vega, delta and gamma" /></div>}
        </Box>

        <Box title="2. IV analysis" note={mode === "fixed" ? `fixed ${tr.fixed.strike} legs` : "rolling ATM legs"} id="sdi-iv">
          <div className="overflow-x-auto"><table className="w-full min-w-[26rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Implied vol (%)</th><th className="py-1 text-right font-normal">Open</th><th className="py-1 text-right font-normal">Now</th><th className="py-1 text-right font-normal">Change (pts)</th><th className="py-1 text-right font-normal">Change (%)</th></tr></thead>
            <tbody><StatRow label="Call IV" s={ivv.ce} /><StatRow label="Put IV" s={ivv.pe} /><StatRow label="Combined ATM IV" s={ivv.combined} />
              <StatRow label="25Δ skew (put − call)" s={iv.skew25} /><StatRow label="10Δ skew (put − call)" s={iv.skew10} /><StatRow label="25Δ risk reversal (call − put)" s={iv.rr25} /><StatRow label="10Δ risk reversal (call − put)" s={iv.rr10} /></tbody></table></div>
          <p className="mt-2 text-xs text-paper" data-testid="sdi-support">{iv.support.text}</p>
          <p className="mt-1 text-xs text-muted">IV change relative to NIFTY: {iv.per_spot_pct == null ? "not defined (spot has moved less than 0.1% since the open)" : `${sg(iv.per_spot_pct, 2)} vol points per 1% spot move since open`}; {iv.iv_vs_spot.slope_pts_per_pct == null ? `intraday slope needs at least 20 pairs (have ${iv.iv_vs_spot.pairs})` : `intraday slope ${sg(iv.iv_vs_spot.slope_pts_per_pct, 2)} points per 1% (corr ${n1(iv.iv_vs_spot.corr, 2)})`}.</p>
          {charts && <div className="mt-2 h-[220px]"><EChart group="sdi" option={charts.iv} ariaLabel="Call, put and combined implied volatility" /></div>}
        </Box>

        <div className="flex flex-col gap-3">
          <Box title="4. Realised vs implied volatility" id="sdi-rv">
            <div className="overflow-x-auto"><table className="w-full min-w-[22rem] text-xs"><thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window</th><th className="py-1 text-right font-normal">Realised vol</th><th className="py-1 text-right font-normal">Implied (now)</th><th className="py-1 text-right font-normal">IV − RV</th></tr></thead>
              <tbody>{["5", "15", "30", "60", "open"].map((k) => { const r = rv.windows[k]; return <tr key={k} className="border-t border-rule/50"><td className="py-1 text-paper">{k === "open" ? "Since open" : `${k} min`}</td><td className="num py-1 text-right" title={r?.note}>{r?.vol_pct == null ? MISSING : `${r.vol_pct.toFixed(1)}%`}</td><td className="num py-1 text-right">{n1(rv.iv_now)}%</td><td className={`num py-1 text-right ${tone(rv.gap[k])}`}>{sg(rv.gap[k])}</td></tr>; })}</tbody></table></div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Implied move" value={`${n1(rv.implied_move_pts)} pts`} sub={rv.implied_move_pct == null ? undefined : `${rv.implied_move_pct.toFixed(2)}% (straddle)`} />
              <Tile label="Implied 1-day SD" value={`${n1(rv.implied_daily_sd_pts)} pts`} sub="forward × IV ÷ √252" />
              <Tile label="NIFTY move" value={`${sg(rv.actual_move_pts, 0)} pts`} sub={`range ${n1(rv.actual_range_pts, 0)}; ${rv.move_vs_daily_sd == null ? MISSING : `${rv.move_vs_daily_sd}× 1-day SD`}`} />
              <Tile label="Realised variance" value={rv.realised_variance.session_move_sd_pct == null ? MISSING : `${rv.realised_variance.session_move_sd_pct}%`} sub={`√Σ(returns²), ${rv.realised_variance.returns} returns`} />
            </div>
            <p className="mt-1 text-[11px] text-muted">{rv.note}</p>
          </Box>
          <Box title="6. Gamma and market structure" id="sdi-structure">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile label="Net GEX" value={st.gex?.net == null ? MISSING : st.gex.net.toFixed(2)} sub={st.gex ? `${st.gex.regime}${st.gex.relationship && st.gex.relationship !== "none" && st.gex.relationship !== "unavailable" ? `, ${st.gex.relationship}` : ""}` : "live session only"} />
              <Tile label="Gamma flip" value={st.gex?.flip == null ? MISSING : String(Math.round(st.gex.flip))} sub={st.gex?.flip_distance_pts == null ? undefined : `${sg(st.gex.flip_distance_pts, 0)} pts from spot`} />
              <Tile label="Gamma near ATM" value={st.concentration?.share_pct == null ? MISSING : `${st.concentration.share_pct}%`} sub="γ × OI within 2 strikes" />
              <Tile label="Straddle theta / day" value={sg(st.straddle_theta_per_day, 1)} sub="points" />
              <Tile label="Break-even daily move" value={`${n1(st.breakeven_daily_move_pts, 0)} pts`} sub={`realised ${n1(st.realised_daily_sd_pts, 0)} pts (${st.realised_vs_breakeven == null ? MISSING : `${st.realised_vs_breakeven}×`})`} />
              <Tile label="NIFTY move" value={`${sg(st.spot_move_pts, 0)} pts`} sub="since first sample" />
            </div>
            <p className="mt-1 text-[11px] text-muted">{st.note}</p>
          </Box>
        </div>
      </div>

      <details className="mt-3 rounded-sm border border-rule" data-testid="sdi-validation" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setWantVal(true); }}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-paper">Validation: predicted theta decay vs actual premium change over stored sessions</summary>
        <div className="border-t border-rule px-3 py-2 text-xs">
          {val.isPending && wantVal ? <p className="text-muted">Computing from stored sessions…</p> : val.isError ? <p className="text-down">Validation could not be computed.</p> : val.data ? (
            <>
              <p className={val.data.sufficient ? "text-paper" : "text-warn"} data-testid="sdi-val-message">{val.data.message}</p>
              <p className="mt-1 text-muted">{val.data.method}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Windows" value={String(val.data.overall.windows)} sub={`${val.data.sessions.length} sessions, ${val.data.window_minutes} min`} />
                <Tile label="Actual ÷ predicted" value={n1(val.data.overall.ratio_actual_to_predicted, 2)} sub="1 = decay as theta alone says" />
                <Tile label="Mean abs error" value={n1(val.data.overall.mae, 2)} sub="points per window" />
                <Tile label="Earlier / later half" value={`${n1(val.data.earlier_half.ratio_actual_to_predicted, 2)} / ${n1(val.data.later_half.ratio_actual_to_predicted, 2)}`} sub="same ratio, chronological split" />
              </div>
              <p className="mt-1 text-muted">{val.data.note}</p>
            </>
          ) : <p className="text-muted">Open to compute from stored sessions.</p>}
        </div>
      </details>
      <p className="mt-2 text-[11px] text-muted" data-testid="sdi-quality">
        {d.proxies} Estimated: {ql.estimated.join("; ")}. {ql.steps_skipped_fixed + ql.steps_skipped_rolling > 0 ? `${ql.steps_skipped_fixed} fixed and ${ql.steps_skipped_rolling} rolling step(s) skipped for a missing price or vol (not filled). ` : ""}Last sample {fmtTimeIST(ql.last_sample_at)}; {d.samples} samples. Opening values are the first stored sample, not the exchange open.
      </p>
    </section>
  );
}
