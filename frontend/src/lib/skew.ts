/**
 * Volatility smile and skew measures from a chain's solved contracts, the same definitions as the backend's `skew_metrics`
 * (backend/app/intraday/volatility.py) so the live page and the stored chain agree:
 *  - the wing IVs at 25 / 10 absolute delta are found by linear interpolation in delta between the two out-of-the-money contracts
 *    that bracket the target (exact on a hit; no extrapolation: outside the listed range the measure is missing);
 *  - skew 25 / 10 delta = put IV minus call IV at that delta (the call-minus-put figure is its negation);
 *  - butterfly 25 / 10 delta = mean of the two wing IVs minus ATM IV;
 *  - slope = least-squares IV points per 1% of moneyness (strike / forward - 1) over the out-of-the-money options.
 * A contract without a solved volatility is left out, never counted as zero.
 */
import type { StrikeGreeks } from "./optionTools";

export interface SmileRow { strike: number; side: "CE" | "PE"; iv: number | null; delta: number | null; otm: boolean }
export interface SkewMeasures {
  skew_25d: number | null; skew_10d: number | null; call_minus_put_25d: number | null; call_minus_put_10d: number | null;
  butterfly_25d: number | null; butterfly_10d: number | null; slope_per_pct: number | null;
  put_25d_iv: number | null; call_25d_iv: number | null; put_10d_iv: number | null; call_10d_iv: number | null;
}

/** The two contracts an interpolated delta point sits between (or the one it sits on), kept so the worked example can show them. */
export interface DeltaPoint { iv: number; target: number; hi: { strike: number; delta: number; iv: number }; lo: { strike: number; delta: number; iv: number } }

/** IV (percent) of the out-of-the-money `side` option at absolute delta `target`: linear interpolation between the bracketing contracts. Null when the target is outside the listed range. */
export function ivAtDelta(rows: SmileRow[], side: "CE" | "PE", target: number): DeltaPoint | null {
  const byDelta = new Map<number, { strike: number; delta: number; iv: number }>();
  for (const r of rows) if (r.side === side && r.otm && r.iv != null && r.delta != null) byDelta.set(Math.round(Math.abs(r.delta) * 1e6) / 1e6, { strike: r.strike, delta: Math.abs(r.delta), iv: r.iv });
  const pts = [...byDelta.entries()].sort((a, b) => b[0] - a[0]).map((e) => ({ ...e[1], delta: e[0] }));
  for (let i = 0; i + 1 < pts.length; i++) {
    const hi = pts[i]!, lo = pts[i + 1]!;
    if (hi.delta >= target && target >= lo.delta) return { iv: hi.delta === lo.delta ? hi.iv : lo.iv + ((target - lo.delta) / (hi.delta - lo.delta)) * (hi.iv - lo.iv), target, hi, lo };
  }
  return null;
}

export function skewMeasures(rows: SmileRow[], forward: number, atmIv: number | null): SkewMeasures {
  const p25 = ivAtDelta(rows, "PE", 0.25)?.iv ?? null, c25 = ivAtDelta(rows, "CE", 0.25)?.iv ?? null;
  const p10 = ivAtDelta(rows, "PE", 0.1)?.iv ?? null, c10 = ivAtDelta(rows, "CE", 0.1)?.iv ?? null;
  const pts = rows.filter((r) => r.otm && r.iv != null && forward > 0).map((r) => [(r.strike / forward - 1) * 100, r.iv!] as const);
  let slope: number | null = null;
  if (pts.length >= 4) {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const vx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    slope = vx === 0 ? null : pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / vx;
  }
  const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
  const both = (p: number | null, c: number | null, f: (p: number, c: number) => number) => (p == null || c == null ? null : r3(f(p, c)));
  return {
    skew_25d: both(p25, c25, (p, c) => p - c), skew_10d: both(p10, c10, (p, c) => p - c),
    call_minus_put_25d: both(p25, c25, (p, c) => c - p), call_minus_put_10d: both(p10, c10, (p, c) => c - p),
    butterfly_25d: atmIv == null ? null : both(p25, c25, (p, c) => (p + c) / 2 - atmIv), butterfly_10d: atmIv == null ? null : both(p10, c10, (p, c) => (p + c) / 2 - atmIv),
    slope_per_pct: slope == null ? null : Math.round(slope * 10000) / 10000,
    put_25d_iv: r3(p25), call_25d_iv: r3(c25), put_10d_iv: r3(p10), call_10d_iv: r3(c10),
  };
}

/** The strikes within `each` listed strikes of the at-the-money strike (the one nearest the forward), both sides, with the out-of-the-money flag. */
export function liveSmile(strikes: StrikeGreeks[], forward: number | null, spot: number, each = 15): { rows: SmileRow[]; atmStrike: number | null; atmIv: number | null } {
  const ks = strikes.map((s) => s.strike).sort((a, b) => a - b);
  if (ks.length === 0) return { rows: [], atmStrike: null, atmIv: null };
  const ref = forward ?? spot;
  let ai = 0;
  ks.forEach((k, i) => { if (Math.abs(k - ref) < Math.abs(ks[ai]! - ref)) ai = i; });
  const atm = ks[ai]!;
  const win = new Set(ks.slice(Math.max(0, ai - each), ai + each + 1));
  const rows: SmileRow[] = [];
  let atmSum = 0, atmN = 0;
  for (const s of strikes) {
    if (!win.has(s.strike)) continue;
    for (const side of ["CE", "PE"] as const) {
      const g = side === "CE" ? s.ce : s.pe;
      const otm = side === "CE" ? s.strike >= atm : s.strike <= atm;
      rows.push({ strike: s.strike, side, iv: g ? g.iv * 100 : null, delta: g ? g.delta : null, otm });
      if (s.strike === atm && g) { atmSum += g.iv * 100; atmN++; }
    }
  }
  rows.sort((a, b) => a.strike - b.strike || (a.side === "PE" ? -1 : 1));
  return { rows, atmStrike: atm, atmIv: atmN ? atmSum / atmN : null };
}

/** The worked example for the skew and butterfly panels, written from the data on screen by the same `ivAtDelta` that computes the numbers. */
export function skewWorkedExample(rows: SmileRow[], atmIv: number | null, target = 0.25): string[] {
  const line = (side: "CE" | "PE") => {
    const d = ivAtDelta(rows, side, target);
    const name = side === "CE" ? "Call" : "Put";
    if (!d) return { text: `${name} IV at ${target} delta: not available (no pair of contracts brackets ${target}).`, iv: null };
    const { hi, lo } = d;
    return {
      text: `${name} IV at ${target} delta = ${lo.iv.toFixed(2)} + (${target} − ${lo.delta.toFixed(3)}) / (${hi.delta.toFixed(3)} − ${lo.delta.toFixed(3)}) × (${hi.iv.toFixed(2)} − ${lo.iv.toFixed(2)}) = ${d.iv.toFixed(3)}%  [strikes ${lo.strike} and ${hi.strike}]`,
      iv: d.iv,
    };
  };
  const p = line("PE"), c = line("CE");
  const out = [p.text, c.text];
  if (p.iv != null && c.iv != null) {
    out.push(`Skew ${Math.round(target * 100)}Δ = ${p.iv.toFixed(3)} − ${c.iv.toFixed(3)} = ${(p.iv - c.iv).toFixed(3)} points`);
    if (atmIv != null) out.push(`Butterfly ${Math.round(target * 100)}Δ = (${p.iv.toFixed(3)} + ${c.iv.toFixed(3)}) / 2 − ${atmIv.toFixed(3)} = ${((p.iv + c.iv) / 2 - atmIv).toFixed(3)} points`);
  }
  return out;
}
