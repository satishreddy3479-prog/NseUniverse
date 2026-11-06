/**
 * Volatility smile and skew measures from a chain's solved contracts, the same definitions as the backend's `skew_metrics`
 * (backend/app/intraday/volatility.py) so the live page and the stored chain agree:
 *  - skew 25 / 10 delta = put IV minus call IV at the out-of-the-money contracts nearest that delta (accepted only within
 *    0.1 / 0.05 of the target; otherwise missing);
 *  - butterfly 25 delta = mean of the two 25-delta wing IVs minus ATM IV;
 *  - slope = least-squares IV points per 1% of moneyness (strike / forward - 1) over the out-of-the-money options.
 * A contract without a solved volatility is left out, never counted as zero.
 */
import type { StrikeGreeks } from "./optionTools";

export interface SmileRow { strike: number; side: "CE" | "PE"; iv: number | null; delta: number | null; otm: boolean }
export interface SkewMeasures { skew_25d: number | null; skew_10d: number | null; butterfly_25d: number | null; slope_per_pct: number | null; put_25d_iv: number | null; call_25d_iv: number | null }

const nearest = (rows: SmileRow[], side: "CE" | "PE", target: number, tol: number): SmileRow | null => {
  const c = rows.filter((r) => r.side === side && r.otm && r.iv != null && r.delta != null);
  let best: SmileRow | null = null;
  for (const r of c) if (best == null || Math.abs(Math.abs(r.delta!) - target) < Math.abs(Math.abs(best.delta!) - target)) best = r;
  return best != null && Math.abs(Math.abs(best.delta!) - target) <= tol ? best : null;
};

export function skewMeasures(rows: SmileRow[], forward: number, atmIv: number | null): SkewMeasures {
  const p25 = nearest(rows, "PE", 0.25, 0.1), c25 = nearest(rows, "CE", 0.25, 0.1);
  const p10 = nearest(rows, "PE", 0.1, 0.05), c10 = nearest(rows, "CE", 0.1, 0.05);
  const pts = rows.filter((r) => r.otm && r.iv != null && forward > 0).map((r) => [(r.strike / forward - 1) * 100, r.iv!] as const);
  let slope: number | null = null;
  if (pts.length >= 4) {
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const vx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    slope = vx === 0 ? null : pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / vx;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    skew_25d: p25 && c25 ? r3(p25.iv! - c25.iv!) : null,
    skew_10d: p10 && c10 ? r3(p10.iv! - c10.iv!) : null,
    butterfly_25d: p25 && c25 && atmIv != null ? r3((p25.iv! + c25.iv!) / 2 - atmIv) : null,
    slope_per_pct: slope == null ? null : Math.round(slope * 10000) / 10000,
    put_25d_iv: p25 ? p25.iv : null, call_25d_iv: c25 ? c25.iv : null,
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
