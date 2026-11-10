import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { fmtInt, MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import type { PositioningBasket, PositioningDemand, PositioningQuote, StrikePositioning as Pos } from "../lib/types";
import { MethodologyPanel } from "./MethodologyPanel";

const WINDOWS = [["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["open", "Since open"], ["prev", "Previous close"]] as const;
const FILTERS = [["5", "ATM ±5"], ["10", "ATM ±10"], ["20", "ATM ±20"], ["all", "All"], ["d25", "25Δ band"], ["d10", "10Δ band"]] as const;
const f1 = (v: number | null | undefined, d = 1) => (v == null ? MISSING : v.toFixed(d));
const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");
const short = (c: string) => c.replace("potential ", "").replace("no clear change", "—").replace("insufficient data", MISSING);

/** Worked example of the first strike that has a full premium and OI change: the arithmetic behind its label. */
export function positioningExample(d: Pos): string[] {
  for (const r of d.rows) for (const [side, q] of [["CE", r.ce], ["PE", r.pe]] as [string, PositioningQuote][]) {
    if (q.premium != null && q.premium_then != null && q.oi != null && q.oi_then != null && q.premium_pct != null && q.oi_pct != null && q.oi_then > 0 && q.premium_then > 0) {
      return [
        `${r.strike} ${side}: premium ${f1(q.premium_then, 2)} → ${f1(q.premium, 2)}: change = ${sg(q.premium_change, 2)}, % = (${f1(q.premium, 2)} / ${f1(q.premium_then, 2)} − 1) × 100 = ${sg(q.premium_pct, 2)}%`,
        `OI ${fmtInt(q.oi_then)} → ${fmtInt(q.oi)}: % = (${fmtInt(q.oi)} / ${fmtInt(q.oi_then)} − 1) × 100 = ${sg(q.oi_pct, 2)}%`,
        `Class: premium ${q.premium_pct > 0 ? "↑" : "↓"}, OI ${q.oi_pct > 0 ? "↑" : "↓"} (each beyond ±0.5%) → ${q.class}`,
      ];
    }
  }
  return [];
}

function inFilter(strike: number, atm: number | null, listed: number[], f: string, delta: number | null): boolean {
  if (f === "all") return true;
  if (f === "d25") return delta != null && Math.abs(Math.abs(delta) - 0.25) <= 0.05;
  if (f === "d10") return delta != null && Math.abs(Math.abs(delta) - 0.1) <= 0.03;
  if (atm == null) return false;
  const i = listed.indexOf(atm), j = listed.indexOf(strike);
  return i >= 0 && j >= 0 && Math.abs(i - j) <= Number(f);
}

function Basket({ b }: { b: PositioningBasket }) {
  const cell = (q: PositioningBasket["ce"]) => <><td className="num py-1 text-right text-paper">{f1(q.now, 1)}</td><td className="num py-1 text-right text-muted">{f1(q.then, 1)}</td><td className={`num py-1 text-right ${tone(q.change)}`}>{sg(q.change, 1)} ({sg(q.pct, 1)}%)</td></>;
  return (
    <tr className="border-t border-rule/50" data-testid="basket-row">
      <td className="py-1 text-muted">{b.window == null ? "All strikes" : `ATM ±${b.window}`} · {b.kind}</td>
      {cell(b.ce)}{cell(b.pe)}
      <td className="num py-1 text-right text-paper" title={b.asymmetry.note ?? "|PE premium change| / |CE premium change|"}>{b.asymmetry.ratio == null ? MISSING : b.asymmetry.ratio.toFixed(2)}</td>
    </tr>
  );
}

function Demand({ d }: { d: PositioningDemand }) {
  const unclear = d.label === "INSUFFICIENT EVIDENCE";
  return (
    <div className="rounded-sm border border-rule bg-slate-2/50 p-2 text-xs" data-testid="demand-card">
      <div className="text-[11px] text-muted">{d.side === "CE" ? "Calls" : "Puts"} · {d.group === "deep" ? "deep OTM (|Δ| ≤ 0.10)" : "OTM"} · {d.summary.strikes} strikes</div>
      <div className={`font-semibold ${unclear ? "text-muted" : "text-paper"}`}>{d.label}</div>
      {d.evidence ? <div className="text-muted">Evidence ({d.evidence.score} of {d.evidence.of}): {d.evidence.met.join(", ")}{d.evidence.unmet.length ? `. Not met: ${d.evidence.unmet.join(", ")}` : ""}.</div>
        : <div className="text-muted">{d.summary.strikes === 0 ? "No strikes with a solved delta in this group." : "No reading has enough supporting conditions."}</div>}
      <div className="mt-1 text-muted">OI {sg(d.summary.oi_pct, 2)}% · premium {sg(d.summary.premium_pct, 2)}% · IV {sg(d.summary.iv_change, 2)} pts · volume {d.summary.volume_change == null ? MISSING : sg(d.summary.volume_change, 0)}</div>
    </div>
  );
}

export function StrikePositioningBody({ expiry }: { expiry: string | null }) {
  const [win, setWin] = useState<string>("15");
  const [flt, setFlt] = useState<string>("10");
  const q = useQuery({ queryKey: ["strikePos", expiry, win], queryFn: () => api.intradayStrikePositioning(expiry!, win), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">Strike positioning could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  const d = q.data;
  if (d.status !== "ok") return <p className="text-sm text-muted" data-testid="pos-empty">{d.status}.</p>;
  const listed = d.rows.map((r) => r.strike);
  const rows = d.rows.filter((r) => inFilter(r.strike, d.atm_strike, listed, flt, r.ce.delta) || inFilter(r.strike, d.atm_strike, listed, flt, r.pe.delta));
  const stale = d.age_seconds > 300;
  const nocmp = d.then_at == null;
  const btn = (on: boolean) => `min-h-8 rounded-sm border px-2 ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
  const th = "py-1 text-right font-normal";
  const cell = (q2: PositioningQuote) => (
    <>
      <td className="num py-1 text-right text-paper">{f1(q2.premium, 2)}</td><td className={`num py-1 text-right ${tone(q2.premium_pct)}`}>{sg(q2.premium_pct, 1)}%</td>
      <td className="num py-1 text-right text-paper">{q2.oi == null ? MISSING : fmtInt(q2.oi)}</td><td className={`num py-1 text-right ${tone(q2.oi_change)}`}>{q2.oi_change == null ? MISSING : sg(q2.oi_change, 0)}</td>
      <td className={`num py-1 text-right ${tone(q2.oi_session_change)}`}>{q2.oi_session_change == null ? MISSING : sg(q2.oi_session_change, 0)}</td>
      <td className="num py-1 text-right text-muted">{q2.volume == null ? MISSING : fmtInt(q2.volume)}</td><td className="num py-1 text-right text-paper">{f1(q2.iv, 1)}</td><td className={`num py-1 text-right ${tone(q2.iv_change)}`}>{sg(q2.iv_change, 2)}</td>
      <td className="num py-1 text-right text-muted">{q2.delta == null ? MISSING : q2.delta.toFixed(2)}</td><td className="py-1 pl-1 text-left text-[11px] text-muted">{short(q2.class)}</td>
    </>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="pos-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span>Expiry {d.expiry} · session {d.session} · NIFTY {fmtInt(d.spot)} ({sg(d.spot_change_pct, 2)}% vs comparison) · ATM {d.atm_strike ?? MISSING}</span>
          <div role="group" aria-label="Compare with" className="flex flex-wrap gap-1">{WINDOWS.map(([k, l]) => <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)} className={btn(win === k)}>{l}</button>)}</div>
          <div role="group" aria-label="Strikes shown" className="flex flex-wrap gap-1">{FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={flt === k} onClick={() => setFlt(k)} className={btn(flt === k)}>{l}</button>)}</div>
        </div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="pos-stale">The newest stored chain is {Math.round(d.age_seconds / 60)} minutes old.</p>}
        {nocmp && <p className="mt-1 text-xs text-warn" data-testid="pos-nocmp">{d.note}</p>}
        <p className="mt-2 text-xs text-muted">Labels are indicative readings of the premium and OI direction. Open interest does not show who bought or sold.</p>
      </div>
      {d.demand.length > 0 && (
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
          <h2 className="mb-2 text-sm font-semibold text-paper">OTM positioning and demand reading</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="demand-grid">{[...d.demand].sort((a, b) => (a.side === b.side ? (a.group === "otm" ? -1 : 1) : a.side === "CE" ? -1 : 1)).map((x) => <Demand key={`${x.side}${x.group}`} d={x} />)}</div>
          <MethodologyPanel metrics={[METRICS.demand_classifier!]} example={demandExample(d.demand)}
            freshness={{ updatedAt: d.at, session: d.session ?? null, expiry: d.expiry, used: d.demand.reduce((a, x) => a + x.summary.strikes, 0), missing: d.demand.reduce((a, x) => a + x.summary.missing, 0), timeframe: `now versus ${d.then_at ?? "(no comparison)"}` }} />
        </div>
      )}
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-2 text-sm font-semibold text-paper">Strike by strike</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] text-xs" data-testid="pos-table">
            <thead>
              <tr className="text-[11px] text-muted"><th rowSpan={2} className="py-1 text-left font-normal">Strike</th><th colSpan={10} className="border-l border-rule/50 py-1 text-center font-normal">Call</th><th colSpan={10} className="border-l border-rule/50 py-1 text-center font-normal">Put</th></tr>
              <tr className="text-[11px] text-muted">{[0, 1].map((s) => ["Prem", "Δ%", "OI", "OI chg", "vs prev day", "Vol", "IV", "IV chg", "Delta", "Class"].map((h) => <th key={`${s}${h}`} className={`${th} ${h === "Prem" ? "border-l border-rule/50" : ""}`}>{h}</th>))}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.strike} className={`border-t border-rule/50 ${r.strike === d.atm_strike ? "bg-brass/10" : ""}`}>
                  <td className="num py-1 text-left text-paper">{fmtInt(r.strike)}{r.strike === d.atm_strike ? " ATM" : ""}</td>{cell(r.ce)}{cell(r.pe)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <MethodologyPanel metrics={[METRICS.oi_premium_class!]} example={positioningExample(d)}
          freshness={{ updatedAt: d.at, session: d.session ?? null, expiry: d.expiry, used: rows.length, missing: d.rows.length - rows.length, timeframe: `now versus ${d.then_at ?? "(no comparison)"}; "excluded" = strikes hidden by the filter` }} />
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-2 text-sm font-semibold text-paper">Aggregate premium: fixed and dynamic baskets, premium asymmetry</h2>
        {d.baskets.length === 0 ? <p className="text-sm text-muted" data-testid="basket-empty">No comparison snapshot, so no basket change.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-xs" data-testid="basket-table">
              <thead><tr className="text-[11px] text-muted"><th className="py-1 text-left font-normal">Basket</th><th className={th}>CE now</th><th className={th}>CE then</th><th className={th}>CE change</th><th className={th}>PE now</th><th className={th}>PE then</th><th className={th}>PE change</th><th className={th}>PE/CE asymmetry</th></tr></thead>
              <tbody>{d.baskets.map((b) => <Basket key={`${b.window}${b.kind}`} b={b} />)}</tbody>
            </table>
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted">Fixed keeps the strikes that were within the window of the ATM at the comparison time; dynamic re-centres on the ATM at each time. Both are shown, never merged.</p>
        <MethodologyPanel metrics={[METRICS.premium_asymmetry!]} example={basketExample(d.baskets)}
          freshness={{ updatedAt: d.at, session: d.session ?? null, expiry: d.expiry, used: d.baskets[0]?.ce.strikes ?? null, missing: null, timeframe: `now versus ${d.then_at ?? "(no comparison)"}` }} />
      </div>
    </div>
  );
}

export function basketExample(bs: PositioningBasket[]): string[] {
  const b = bs.find((x) => x.window === 10 && x.kind === "fixed") ?? bs[0];
  if (!b || b.ce.change == null || b.pe.change == null) return [];
  const lab = `${b.window == null ? "all strikes" : `ATM ±${b.window}`}, ${b.kind}`;
  return [
    `Basket: ${lab} (${b.ce.strikes} strikes priced at both times)`,
    `CE premium ${f1(b.ce.then, 2)} → ${f1(b.ce.now, 2)}: change ${sg(b.ce.change, 2)}; PE premium ${f1(b.pe.then, 2)} → ${f1(b.pe.now, 2)}: change ${sg(b.pe.change, 2)}`,
    b.asymmetry.ratio == null ? `Asymmetry: not shown (${b.asymmetry.note})` : `Asymmetry = ${f1(Math.abs(b.pe.change), 2)} / ${f1(Math.abs(b.ce.change), 2)} = ${b.asymmetry.ratio.toFixed(4)}`,
  ];
}

export function demandExample(ds: PositioningDemand[]): string[] {
  const x = ds.find((d) => d.evidence) ?? ds[0];
  if (!x) return [];
  const g = x.summary;
  return [
    `${x.side === "CE" ? "Calls" : "Puts"}, ${x.group === "deep" ? "deep OTM" : "OTM"} group (${g.strikes} strikes): premium ${sg(g.premium_pct, 2)}%, OI ${sg(g.oi_pct, 2)}%, IV ${sg(g.iv_change, 2)} pts, volume ${g.volume_change == null ? MISSING : sg(g.volume_change, 0)}`,
    x.evidence ? `${x.evidence.label}: ${x.evidence.score} of ${x.evidence.of} conditions hold (${x.evidence.met.join(", ")})` : "No label reaches 3 conditions and 75% of its list: INSUFFICIENT EVIDENCE",
  ];
}
