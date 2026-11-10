import { MISSING } from "../lib/format";
import { METRICS } from "../lib/metricRegistry";
import { ivAtDelta, type SmileRow } from "../lib/skew";
import type { IvSkew } from "../lib/types";
import { MethodologyPanel } from "./MethodologyPanel";

export interface SmileView {
  label: string; session: string | null; expiry: string; atmIv: number | null; at: string | null;
  smile: { strike: number; side: "CE" | "PE"; iv: number | null; delta: number | null }[];
}
export const toView = (d: IvSkew, label: string): SmileView => ({ label, session: d.session ?? null, expiry: d.expiry ?? "", atmIv: d.atm_iv ?? null, at: d.at ?? null, smile: d.smile.map((p) => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta ?? null })) });

const rowsOf = (v: SmileView): SmileRow[] => v.smile.map((p) => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta, otm: true }));
const pt = (v: SmileView, side: "CE" | "PE", t: number) => ivAtDelta(rowsOf(v), side, t)?.iv ?? null;
const f2 = (x: number | null | undefined) => (x == null ? MISSING : x.toFixed(2));
const sg = (x: number | null) => (x == null ? MISSING : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`);

/** The measures compared between two smiles of the same expiry. Each is the same interpolated value the skew cards use. */
export function compareRows(now: SmileView, then: SmileView): { label: string; now: number | null; then: number | null; diff: number | null }[] {
  const mk = (label: string, a: number | null, b: number | null) => ({ label, now: a, then: b, diff: a == null || b == null ? null : a - b });
  const skew = (v: SmileView, t: number) => { const p = pt(v, "PE", t), c = pt(v, "CE", t); return p == null || c == null ? null : p - c; };
  return [
    mk("ATM IV", now.atmIv, then.atmIv),
    mk("25Δ call IV", pt(now, "CE", 0.25), pt(then, "CE", 0.25)), mk("25Δ put IV", pt(now, "PE", 0.25), pt(then, "PE", 0.25)),
    mk("10Δ call IV", pt(now, "CE", 0.1), pt(then, "CE", 0.1)), mk("10Δ put IV", pt(now, "PE", 0.1), pt(then, "PE", 0.1)),
    mk("25Δ skew (put − call)", skew(now, 0.25), skew(then, 0.25)), mk("10Δ skew (put − call)", skew(now, 0.1), skew(then, 0.1)),
  ];
}

/** Worked example: the 25-delta call IV of both smiles from their own bracketing contracts, and the difference. */
export function compareExample(now: SmileView, then: SmileView): string[] {
  const line = (v: SmileView) => {
    const d = ivAtDelta(rowsOf(v), "CE", 0.25);
    return d ? `${v.label} (${v.session ?? "live"}): 25Δ call IV = ${d.lo.iv.toFixed(2)} + (0.25 − ${d.lo.delta.toFixed(3)}) / (${d.hi.delta.toFixed(3)} − ${d.lo.delta.toFixed(3)}) × (${d.hi.iv.toFixed(2)} − ${d.lo.iv.toFixed(2)}) = ${d.iv.toFixed(3)}% [strikes ${d.lo.strike}, ${d.hi.strike}]` : `${v.label}: no pair of contracts brackets 25 delta`;
  };
  const a = pt(now, "CE", 0.25), b = pt(then, "CE", 0.25);
  return [line(now), line(then), a != null && b != null ? `Change = ${a.toFixed(3)} − ${b.toFixed(3)} = ${(a - b).toFixed(3)} IV points` : "Change: not available (one smile lacks 25Δ)"];
}

export function SmileComparePanel({ now, then, sessions, value, onChange, loading, error }: {
  now: SmileView; then: SmileView | null; sessions: string[]; value: string | null; onChange: (s: string | null) => void; loading: boolean; error: string | null;
}) {
  const options = sessions.filter((d) => d !== now.session);
  const strikes = [...new Set([...now.smile, ...(then?.smile ?? [])].map((p) => p.strike))].sort((a, b) => a - b);
  const find = (v: SmileView | null, k: number) => v?.smile.find((p) => p.strike === k) ?? null;
  const rows = then ? compareRows(now, then) : [];
  return (
    <div className="mt-3 border-t border-rule pt-3" data-testid="smile-compare">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <label className="flex items-center gap-1">Compare with session
          <select aria-label="Compare with session" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-1 text-paper">
            <option value="">none</option>{options.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <span>Same expiry ({now.expiry}) on both sides; each smile is the last in-session stored chain of its session.</span>
      </div>
      {options.length === 0 && <p className="mt-2 text-xs text-warn" data-testid="smile-compare-none">No other session has a stored chain for this expiry, so there is nothing to compare with.</p>}
      {loading && <p className="mt-2 text-xs text-muted">Loading the comparison session…</p>}
      {error && <p role="alert" className="mt-2 text-xs text-down">The comparison session could not be loaded: {error}</p>}
      {then && (
        <>
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[28rem] max-w-[40rem] text-xs" data-testid="smile-compare-table">
            <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Measure (IV %, points)</th><th className="py-1 text-right font-normal">{now.session ?? "Now"}</th><th className="py-1 text-right font-normal">{then.session}</th><th className="py-1 text-right font-normal">Change</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.label} className="border-t border-rule/50"><td className="py-1 text-muted">{r.label}</td><td className="num py-1 text-right text-paper">{f2(r.now)}</td><td className="num py-1 text-right text-muted">{f2(r.then)}</td><td className={`num py-1 text-right ${r.diff == null ? "text-muted" : r.diff >= 0 ? "text-up" : "text-down"}`}>{sg(r.diff)}</td></tr>)}</tbody>
          </table></div>
          <details className="mt-2 text-xs" data-testid="smile-align"><summary className="cursor-pointer text-info">Strike and delta alignment (every observation)</summary>
            <div className="mt-1 max-h-72 overflow-auto"><table className="w-full min-w-[34rem] text-xs">
              <thead className="sticky top-0 bg-slate text-[11px] text-muted"><tr><th className="py-1 text-left font-normal">Strike</th><th className="py-1 text-left font-normal">Option</th><th className="py-1 text-right font-normal">Δ now</th><th className="py-1 text-right font-normal">IV now</th><th className="py-1 text-right font-normal">Δ then</th><th className="py-1 text-right font-normal">IV then</th><th className="py-1 text-right font-normal">IV change</th></tr></thead>
              <tbody>{strikes.map((k) => { const a = find(now, k), b = find(then, k); const ch = a?.iv != null && b?.iv != null ? a.iv - b.iv : null; return (
                <tr key={k} className="border-t border-rule/50"><td className="num py-1 text-paper">{k}</td><td className="py-1 text-muted">{(a ?? b)?.side === "CE" ? "Call" : "Put"}</td>
                  <td className="num py-1 text-right text-muted">{a?.delta == null ? MISSING : a.delta.toFixed(2)}</td><td className="num py-1 text-right text-paper">{f2(a?.iv)}</td>
                  <td className="num py-1 text-right text-muted">{b?.delta == null ? MISSING : b.delta.toFixed(2)}</td><td className="num py-1 text-right text-paper">{f2(b?.iv)}</td><td className="num py-1 text-right">{sg(ch)}</td></tr>); })}</tbody>
            </table></div>
          </details>
        </>
      )}
      <MethodologyPanel metrics={[METRICS.smile_compare!]} example={then ? compareExample(now, then) : []}
        freshness={{ updatedAt: now.at, session: then ? `${now.session ?? "live"} vs ${then.session}` : now.session, expiry: now.expiry, used: now.smile.filter((p) => p.iv != null).length + (then?.smile.filter((p) => p.iv != null).length ?? 0), missing: now.smile.filter((p) => p.iv == null).length + (then?.smile.filter((p) => p.iv == null).length ?? 0), timeframe: "last in-session stored chain of each session" }} />
    </div>
  );
}
