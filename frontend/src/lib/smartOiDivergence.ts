/**
 * Divergence indicators on Smart OI: places where price and the positioning behind it disagree. Eight indicators, all pure functions of what Smart OI
 * already holds (candles of 3 or 5 minutes) plus, where noted, the stored per-strike series and the NIFTY future:
 *
 *   1 flow        price against cumulative Smart OI at confirmed swing highs and lows (regular and hidden)
 *   2 writing     who is paying: the OI change of each strike read with its delta-adjusted premium change (writing, buying, covering, unwinding),
 *                 against the direction the Smart OI label gives
 *   3 conviction  new positions per option contract traded: a move on churn, or absorption without a move
 *   4 pcr         OI PCR against volume PCR, and against price
 *   5 future      NIFTY future build-up (price and OI) against the direction of Smart OI
 *   6 zone        change of put OI below spot against change of call OI above it, against price
 *   7 momentum    the speed of Smart OI (smoothed) against the speed of price; unusual size
 *   8 composite   how many of the others agree, and how good the evidence is
 *
 * Rules that hold everywhere: a missing value stays missing (no signal is built on a guess), a candle after a gap or with a changed strike count is
 * flagged and lowers the evidence grade, nothing looks ahead (a swing is confirmed only after its right-hand candles exist), and every threshold is in
 * ``TH`` and provisional: these are indicators, not validated predictions. They never produce an order or a target.
 */
import { RISK_FREE_RATE } from "./assumptions";
import { contractDelta, expiryEnd } from "./optionModel";
import { spotEndFor } from "./session";
import { optRisk } from "./advancedGreeks";
import type { SmartOiCandle, SmartOiResult } from "./optionTools";
import type { FuturesSeries, StrikeSeries } from "./types";

export type Direction = "bullish" | "bearish" | "neutral";
export type IndicatorId = "flow" | "writing" | "conviction" | "pcr" | "future" | "zone" | "momentum";
export type SignalState = "confirmed" | "failed";
export type Grade = "A" | "B" | "C";

export const INDICATOR_NAMES: Record<IndicatorId | "composite", string> = {
  flow: "Flow divergence", writing: "Writing or buying", conviction: "Conviction", pcr: "PCR divergence",
  future: "Future against options", zone: "Zone divergence", momentum: "Momentum divergence", composite: "Composite",
};

/** Provisional thresholds. Read by the tests and by the research script; change them only with a stored-session test behind it. */
export const TH = {
  /** minutes: a window of recent candles for the rolling indicators, and the longest distance between two swings */
  windowMin: 30, maxSwingMin: 180,
  flowMinPriceMove: 0.0005, flowMinCsoiShare: 0.1,
  writingMinBias: 0.5, writingMinClassified: 0.5, writingPremiumTick: 0.05, writingPremiumPct: 0.002,
  convMinMove: 0.0015, convLow: 0.5, convHigh: 1.5, convFlatMove: 0.0005,
  pcrMin: 0.03, pcrPriceMin: 0.0015, pcrVsPrice: 0.05,
  futPriceMove: 0.001, futOiMove: 0.005, futConsistency: 0.2,
  zoneMove: 0.0015, zoneShare: 0.3,
  momMove: 0.001, momSlope: 0.3, momZ: 2.5,
  composite: { minAgree: 3, minLead: 2 },
} as const;

/** The candle lengths the indicators are built for. */
export const DIVERGENCE_TIMEFRAMES = [1, 3, 5] as const;
/**
 * What counts in candles differs by candle length, so that the same stretch of time is meant on every one. 3 and 5 minutes are the values the indicators were built and tested with.
 * One minute keeps the same minutes: a swing needs 8 candles each side (3 minutes: 3 candles = 9 minutes), two swings at least 9 candles apart, the momentum average spans 15 candles
 * (3 minutes: 5), writing or buying must hold for 6 candles in a row (3 minutes: 2 = 6 minutes), conviction needs 24 candles of the day's history (3 minutes: 8). The window of 30 minutes,
 * the longest swing of 180 and the percentages of price move are in minutes or per window already and are not touched.
 */
export const TFP: Record<number, { pivotK: number; minSwing: number; emaSpan: number; streak: number; convMin: number }> = {
  1: { pivotK: 8, minSwing: 9, emaSpan: 15, streak: 6, convMin: 24 },
  3: { pivotK: 3, minSwing: 3, emaSpan: 5, streak: 2, convMin: 8 },
  5: { pivotK: 2, minSwing: 3, emaSpan: 5, streak: 2, convMin: 8 },
};
export const tfp = (tf: number) => TFP[tf] ?? TFP[3]!;

export interface Signal {
  id: IndicatorId;
  /** candle index at which the signal was confirmed (nothing after this candle was used) */
  i: number;
  at: string;
  direction: Direction;
  /** 0 to 1: how far past its threshold the evidence is */
  strength: number;
  /** a flow divergence is failed when price later goes beyond the swing it was built on */
  state: SignalState;
  failedAt?: number;
  title: string;
  text: string;
  evidence: Record<string, number | string | null>;
  /** for a flow divergence: the two swing candles, for the line drawn between them */
  link?: { a: number; b: number; price: "high" | "low" };
}

export interface Reading { id: IndicatorId; active: boolean; direction: Direction; strength: number; at: string | null; text: string }
export interface Composite { direction: Direction; bullish: number; bearish: number; agree: number; grade: Grade; text: string }

export interface QualityFlags { gap: boolean; strikes: boolean; proxy: boolean; noSpot: boolean }
export interface DivergenceReport {
  day: string | null; timeframe: number; candles: number;
  signals: Signal[];
  readings: Reading[];
  composite: Composite;
  quality: QualityFlags[];
  /** which optional inputs were missing, so the page can say why an indicator is silent */
  missing: { strikes: boolean; future: boolean };
}

// ---------------------------------------------------------------- small helpers
const sgn = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
const dirOf = (v: number): Direction => (v > 0 ? "bullish" : v < 0 ? "bearish" : "neutral");
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fnum = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
export const candlesFor = (tf: number, minutes: number): number => Math.max(2, Math.ceil(minutes / tf));

interface Frame {
  tf: number; day: string | null; n: number; w: number;
  c: SmartOiCandle[];
  close: (number | null)[]; high: (number | null)[]; low: (number | null)[];
  p: (number | null)[]; csoi: (number | null)[];
}
const frameOf = (res: SmartOiResult): Frame => {
  const c = res.candles;
  return {
    tf: res.timeframe, day: res.day, n: c.length, w: candlesFor(res.timeframe, TH.windowMin), c,
    close: c.map((x) => x.spot?.close ?? null), high: c.map((x) => x.spot?.high ?? null), low: c.map((x) => x.spot?.low ?? null),
    p: c.map((x) => x.p), csoi: c.map((x) => (x.spot || x.p != null ? x.diffDay : null)),
  };
};
const ret = (f: Frame, i: number, w: number): number | null => {
  const a = f.close[i - w], b = f.close[i];
  return i - w >= 0 && fnum(a) && fnum(b) && a > 0 ? b / a - 1 : null;
};
const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(2)}%`;
const units = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;

// ---------------------------------------------------------------- 1 flow divergence
function flow(f: Frame): Signal[] {
  const out: Signal[] = [];
  const k = tfp(f.tf).pivotK;
  const maxGap = candlesFor(f.tf, TH.maxSwingMin);
  const csoiOk = f.csoi.filter(fnum);
  if (csoiOk.length < 2 * k + 2) return out;
  const pivots = (kind: "high" | "low") => {
    const series = kind === "high" ? f.high : f.low;
    const idx: number[] = [];
    for (let j = k; j < f.n - k; j++) {
      const v = series[j];
      if (!fnum(v) || !fnum(f.csoi[j])) continue;
      let ok = true;
      for (let q = 1; q <= k && ok; q++) {
        const l = series[j - q], r = series[j + q];
        if (!fnum(l) || !fnum(r)) { ok = false; break; }
        if (kind === "high" ? !(v >= l && v > r) : !(v <= l && v < r)) ok = false;
      }
      if (ok) idx.push(j);
    }
    return idx;
  };
  for (const kind of ["high", "low"] as const) {
    const series = kind === "high" ? f.high : f.low;
    const pv = pivots(kind);
    for (let t = 1; t < pv.length; t++) {
      const a = pv[t - 1]!, b = pv[t]!;
      if (b - a < tfp(f.tf).minSwing || b - a > maxGap) continue;
      const pa = series[a]!, pb = series[b]!, ca = f.csoi[a]!, cb = f.csoi[b]!;
      const upTo = f.csoi.slice(0, b + k + 1).filter(fnum);
      const range = Math.max(...upTo) - Math.min(...upTo);
      if (range <= 0) continue;
      const dPrice = pb / pa - 1, dFlow = cb - ca;
      if (Math.abs(dPrice) < TH.flowMinPriceMove || Math.abs(dFlow) < TH.flowMinCsoiShare * range) continue;
      let kindName: string | null = null, direction: Direction = "neutral";
      if (kind === "high") {
        if (dPrice > 0 && dFlow < 0) { kindName = "Regular bearish: price made a higher high, cumulative Smart OI a lower one"; direction = "bearish"; }
        else if (dPrice < 0 && dFlow > 0) { kindName = "Hidden bearish: price made a lower high while cumulative Smart OI made a higher one"; direction = "bearish"; }
      } else if (dPrice < 0 && dFlow > 0) { kindName = "Regular bullish: price made a lower low, cumulative Smart OI a higher one"; direction = "bullish"; }
      else if (dPrice > 0 && dFlow < 0) { kindName = "Hidden bullish: price made a higher low while cumulative Smart OI made a lower one"; direction = "bullish"; }
      if (!kindName) continue;
      const i = b + k; // the swing at b is only known once k candles to its right exist
      let failedAt: number | undefined;
      for (let q = i + 1; q < f.n; q++) {
        const v = series[q];
        if (fnum(v) && (kind === "high" ? v > pb : v < pb)) { failedAt = q; break; }
      }
      out.push({
        id: "flow", i, at: f.c[i]!.label, direction, strength: clamp01(Math.abs(dFlow) / range / 0.5), state: failedAt != null && direction !== "neutral" && failedAt > i ? "failed" : "confirmed",
        failedAt, title: "Flow divergence", text: `${kindName} (${f.c[a]!.label} to ${f.c[b]!.label}).`,
        evidence: { priceChange: dPrice, flowChange: dFlow, flowRange: range, swingA: f.c[a]!.label, swingB: f.c[b]!.label },
        link: { a, b, price: kind },
      });
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

// ---------------------------------------------------------------- the per-strike frame (indicators 2 and 6)
export type FlowKind = "writing" | "buying" | "covering" | "unwinding";
export interface StrikeFlow {
  /** units of OI per side and kind in this candle against the previous one (positive numbers) */
  put: Record<FlowKind, number>; call: Record<FlowKind, number>;
  /** OI change that could not be classified (premium moved less than the threshold) */
  unclassified: number;
  /** signed change of put OI at strikes at or below spot, call OI at or above it */
  supportDelta: number; resistDelta: number;
  /** strike with the largest put OI added (below spot) and call OI added (above spot) in this candle */
  supportStrike: number | null; resistStrike: number | null;
  strikes: number;
}
const kinds = (): Record<FlowKind, number> => ({ writing: 0, buying: 0, covering: 0, unwinding: 0 });

/** Per candle, how every stored strike's OI moved and what its premium did against its delta: from the stored one-minute series of the strikes near the money. */
export function buildStrikeFlow(res: SmartOiResult, ss: StrikeSeries, openMin: number): (StrikeFlow | null)[] {
  const IST = 5.5 * 3600_000;
  const lastIdx = new Map<number, number>();
  ss.times.forEach((x, i) => {
    const t = Date.parse(x);
    if (!Number.isFinite(t)) return;
    const d = new Date(t + IST);
    if (d.toISOString().slice(0, 10) !== res.day) return;
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m < openMin) return;
    lastIdx.set(Math.floor((m - openMin) / res.timeframe), i);
  });
  const get = (rec: Record<string, (number | null)[]> | undefined, strike: number, i: number): number | null => {
    const arr = rec?.[String(strike)] ?? rec?.[strike.toFixed(1)] ?? rec?.[Object.keys(rec ?? {}).find((k) => Number(k) === strike) ?? ""];
    const v = arr?.[i];
    return v == null ? null : v;
  };
  return res.candles.map((c, ci) => {
    if (ci === 0) return null;
    const prev = res.candles[ci - 1]!;
    if (!c.spot || !prev.spot) return null; // no index price for the candle (from the cash end): the premium cannot be read against an index move
    const a = lastIdx.get(prev.slot), b = lastIdx.get(c.slot);
    if (a == null || b == null) return null;
    const s0 = ss.spot[a], s1 = ss.spot[b];
    if (!fnum(s0) || !fnum(s1)) return null;
    const nowMs = Date.parse(ss.times[a]!);
    const out: StrikeFlow = { put: kinds(), call: kinds(), unclassified: 0, supportDelta: 0, resistDelta: 0, supportStrike: null, resistStrike: null, strikes: 0 };
    let bestPut = 0, bestCall = 0;
    const rows: { side: "CE" | "PE"; dOi: number; model: number; resid: number; delta: number; vega: number }[] = [];
    const T1 = (expiryEnd(ss.expiry) - Date.parse(ss.times[b]!)) / (365 * 86_400_000);
    for (const strike of ss.strikes) {
      for (const side of ["CE", "PE"] as const) {
        const oi = side === "CE" ? ss.ce_oi : ss.pe_oi, px = side === "CE" ? ss.ce_price : ss.pe_price;
        const o0 = get(oi, strike, a), o1 = get(oi, strike, b);
        if (!fnum(o0) || !fnum(o1)) continue;
        const dOi = o1 - o0;
        if (side === "PE" && strike <= s1) { out.supportDelta += dOi; if (dOi > bestPut) { bestPut = dOi; out.supportStrike = strike; } }
        if (side === "CE" && strike >= s1) { out.resistDelta += dOi; if (dOi > bestCall) { bestCall = dOi; out.resistStrike = strike; } }
        const p0 = get(px, strike, a), p1 = get(px, strike, b);
        const cd = fnum(p0) && p0 > 0 ? contractDelta(side, p0, s0, strike, ss.expiry, nowMs, RISK_FREE_RATE) : null;
        const g = cd && T1 > 0 ? optRisk(side, s1, strike, T1, cd.iv, RISK_FREE_RATE, RISK_FREE_RATE) : null;
        if (!cd || !g || !fnum(p1) || !(p1 > 0)) { if (dOi !== 0) out.unclassified += Math.abs(dOi); continue; }
        // the premium the market should show now if only the index and the clock had moved, at the volatility it had: an exact re-pricing (no delta-gamma
        // approximation, which fails on a 100-point move or on expiry day) that also carries the time decay of the candle
        rows.push({ side, dOi, model: g.price, resid: p1 - g.price, delta: g.delta, vega: g.vega });
      }
    }
    // What the whole chain did in this candle says nothing about who wrote or bought: option prices follow a forward that is a little different from the index
    // we read (a shift of dF index points moves every premium by its delta x dF, calls and puts in opposite directions) and a common volatility move (dSigma moves
    // every premium by its vega x dSigma). Both are fitted on every contract of the candle (least squares, outliers trimmed once) and taken out; only what an
    // individual strike did on top is read as writing or buying. Needs eight contracts; with fewer there is no chain to compare with and nothing is removed.
    const fit = (use: typeof rows): { dF: number; dS: number } | null => {
      let sdd = 0, sdv = 0, svv = 0, sdr = 0, svr = 0;
      for (const r of use) { const w = 1 / (1 + r.model); sdd += w * r.delta * r.delta; sdv += w * r.delta * r.vega; svv += w * r.vega * r.vega; sdr += w * r.delta * r.resid; svr += w * r.vega * r.resid; }
      const det = sdd * svv - sdv * sdv;
      if (!(Math.abs(det) > 1e-12 * Math.max(1, sdd * svv))) return null;
      return { dF: (sdr * svv - svr * sdv) / det, dS: (svr * sdd - sdr * sdv) / det };
    };
    let common = { dF: 0, dS: 0 };
    if (rows.length >= 8) {
      const first = fit(rows);
      if (first) {
        const e = rows.map((r) => r.resid - r.delta * first.dF - r.vega * first.dS);
        const mad = median(e.map((x) => Math.abs(x)))! * 1.4826;
        const kept = mad > 0 ? rows.filter((_, i) => Math.abs(e[i]!) <= 3 * mad) : rows;
        common = (kept.length >= 8 ? fit(kept) : null) ?? first;
      }
    }
    for (const r of rows) {
      if (r.dOi === 0) continue;
      const resid = r.resid - r.delta * common.dF - r.vega * common.dS;
      if (Math.abs(resid) < Math.max(TH.writingPremiumTick, TH.writingPremiumPct * Math.max(r.model, 0.05))) { out.unclassified += Math.abs(r.dOi); continue; }
      const kind: FlowKind = r.dOi > 0 ? (resid < 0 ? "writing" : "buying") : resid > 0 ? "covering" : "unwinding";
      (r.side === "PE" ? out.put : out.call)[kind] += Math.abs(r.dOi);
      out.strikes++;
    }
    return out;
  });
}

/** Direction each kind of change gives: writing puts or buying calls is bullish, writing calls or buying puts bearish; covering reverses the writer's side, unwinding the buyer's. */
const PUT_SIGN: Record<FlowKind, 1 | -1> = { writing: 1, buying: -1, covering: -1, unwinding: 1 };
const CALL_SIGN: Record<FlowKind, 1 | -1> = { writing: -1, buying: 1, covering: 1, unwinding: -1 };
export function pressureOf(sf: StrikeFlow): { bias: number | null; classified: number; share: number | null } {
  let signed = 0, tot = 0;
  for (const k of Object.keys(PUT_SIGN) as FlowKind[]) { signed += PUT_SIGN[k] * sf.put[k] + CALL_SIGN[k] * sf.call[k]; tot += sf.put[k] + sf.call[k]; }
  const all = tot + sf.unclassified;
  return { bias: tot > 0 ? signed / tot : null, classified: tot, share: all > 0 ? tot / all : null };
}

// ---------------------------------------------------------------- 2 writing or buying
function writing(f: Frame, sfs: (StrikeFlow | null)[]): Signal[] {
  const out: Signal[] = [];
  let streak = 0;
  for (let i = 0; i < f.n; i++) {
    const sf = sfs[i], p = f.p[i];
    const pr = sf ? pressureOf(sf) : null;
    const conflict = !!pr && pr.bias != null && pr.share != null && p != null && p !== 0 && Math.abs(pr.bias) >= TH.writingMinBias && pr.share >= TH.writingMinClassified && sgn(p) !== sgn(pr.bias);
    streak = conflict ? streak + 1 : 0;
    if (conflict && streak >= tfp(f.tf).streak) {
      const bias = pr!.bias!;
      out.push({
        id: "writing", i, at: f.c[i]!.label, direction: dirOf(bias), strength: clamp01(Math.abs(bias)), state: "confirmed", title: "Writing or buying",
        text: `Smart OI reads ${p! > 0 ? "bullish (puts added faster)" : "bearish (calls added faster)"} but the premiums say the money is ${bias > 0 ? "bullish" : "bearish"}: ${bias > 0 ? "puts written or calls bought" : "calls written or puts bought"} (${tfp(f.tf).streak * f.tf} minutes in a row).`,
        evidence: { smartOi: p!, bias, classifiedShare: pr!.share!, putWriting: sf!.put.writing, putBuying: sf!.put.buying, callWriting: sf!.call.writing, callBuying: sf!.call.buying },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 3 conviction
function conviction(f: Frame): Signal[] {
  const out: Signal[] = [];
  const conv: (number | null)[] = f.c.map((c) => {
    const vol = fnum(c.ceVolDelta) && fnum(c.peVolDelta) ? c.ceVolDelta + c.peVolDelta : null;
    const oi = fnum(c.dCe) && fnum(c.dPe) ? Math.abs(c.dCe) + Math.abs(c.dPe) : null;
    return vol != null && vol > 0 && oi != null && !c.fromPrevClose ? oi / vol : null;
  });
  const vols = f.c.map((c) => (fnum(c.ceVolDelta) && fnum(c.peVolDelta) && !c.fromPrevClose ? c.ceVolDelta + c.peVolDelta : null));
  for (let i = f.w; i < f.n; i++) {
    // the day's usual level is read from the candles before the window, so the window being judged does not pull its own yardstick toward itself
    const hist = conv.slice(0, i - f.w + 1).filter(fnum), vh = vols.slice(0, i - f.w + 1).filter(fnum);
    if (hist.length < tfp(f.tf).convMin) continue;
    const mc = median(hist)!, mv = median(vh)!;
    const win = conv.slice(i - f.w + 1, i + 1).filter(fnum), wv = vols.slice(i - f.w + 1, i + 1).filter(fnum);
    if (win.length < Math.ceil(f.w / 2) || wv.length < Math.ceil(f.w / 2) || mc <= 0) continue;
    const cw = win.reduce((a, b) => a + b, 0) / win.length, vw = wv.reduce((a, b) => a + b, 0) / wv.length;
    const r = ret(f, i, f.w);
    if (r == null) continue;
    if (Math.abs(r) >= TH.convMinMove && cw <= TH.convLow * mc && vw >= mv) {
      out.push({
        id: "conviction", i, at: f.c[i]!.label, direction: r > 0 ? "bearish" : "bullish", strength: clamp01(1 - cw / (TH.convLow * mc)), state: "confirmed", title: "Conviction",
        text: `${r > 0 ? "Rally" : "Fall"} of ${pct(r)} on churn: plenty of volume, little new open interest per contract traded (${(cw / mc).toFixed(2)} of the day's median). A move like this is weaker than it looks.`,
        evidence: { move: r, convRatio: cw / mc, volumeRatio: vw / mv },
      });
    } else if (Math.abs(r) <= TH.convFlatMove && cw >= TH.convHigh * mc) {
      out.push({
        id: "conviction", i, at: f.c[i]!.label, direction: "neutral", strength: clamp01((cw / mc - TH.convHigh) / TH.convHigh), state: "confirmed", title: "Conviction",
        text: `Positions are being built without a move (${(cw / mc).toFixed(2)} times the day's median new OI per contract traded, price ${pct(r)}): absorption, a larger move may be stored up.`,
        evidence: { move: r, convRatio: cw / mc },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 4 PCR divergence
function pcr(f: Frame): Signal[] {
  const out: Signal[] = [];
  for (let i = f.w; i < f.n; i++) {
    const a = f.c[i - f.w]!, b = f.c[i]!;
    if (!fnum(a.pcr) || !fnum(b.pcr)) continue;
    const dOi = b.pcr - a.pcr, r = ret(f, i, f.w);
    if (fnum(a.volPcr) && fnum(b.volPcr)) {
      const dVol = b.volPcr - a.volPcr;
      if (Math.abs(dOi) >= TH.pcrMin && Math.abs(dVol) >= TH.pcrMin && sgn(dOi) !== sgn(dVol)) {
        out.push({
          id: "pcr", i, at: b.label, direction: dirOf(dOi), strength: clamp01(Math.min(Math.abs(dOi), Math.abs(dVol)) / (TH.pcrMin * 4)), state: "confirmed", title: "PCR divergence",
          text: `What is held and what is traded disagree: OI PCR ${dOi > 0 ? "rose" : "fell"} ${Math.abs(dOi).toFixed(2)} while volume PCR ${dVol > 0 ? "rose" : "fell"} ${Math.abs(dVol).toFixed(2)} over ${f.w * f.tf} minutes. Positions held lead (${dOi > 0 ? "more puts held" : "more calls held"}).`,
          evidence: { oiPcrChange: dOi, volPcrChange: dVol },
        });
      }
    }
    if (r != null && Math.abs(r) >= TH.pcrPriceMin && Math.abs(dOi) >= TH.pcrVsPrice && sgn(r) !== sgn(dOi)) {
      out.push({
        id: "pcr", i, at: b.label, direction: dirOf(dOi), strength: clamp01(Math.abs(dOi) / (TH.pcrVsPrice * 4)), state: "confirmed", title: "PCR divergence",
        text: `Price ${r > 0 ? "rose" : "fell"} ${pct(r)} while OI PCR ${dOi > 0 ? "rose" : "fell"} ${Math.abs(dOi).toFixed(2)}: ${dOi > 0 ? "put support is building against the move" : "put support is thinning behind the move"}.`,
        evidence: { priceChange: r, oiPcrChange: dOi },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 5 future against options
export interface FutureLeg { price: number | null; oi: number | null; basis: number | null }
/** The NIFTY future at the end of each candle: the last stored value not later than the candle's end and within a candle of it. */
export function alignFuture(res: SmartOiResult, fut: FuturesSeries | undefined): FutureLeg[] {
  const empty: FutureLeg = { price: null, oi: null, basis: null };
  if (!fut || !res.day || fut.times.length === 0) return res.candles.map(() => empty);
  const ft = fut.times.map((x) => Date.parse(x));
  return res.candles.map((c) => {
    const end = Date.parse(`${res.day}T${c.label}:00+05:30`) + res.timeframe * 60_000;
    let j = -1;
    for (let q = 0; q < ft.length; q++) if (ft[q]! <= end) j = q; else break;
    if (j < 0 || end - ft[j]! > (res.timeframe + 1) * 60_000) return empty;
    const px = fut.future[j];
    return { price: fnum(px) && px > 0 ? px : null, oi: fnum(fut.oi[j]) ? fut.oi[j]! : null, basis: fnum(fut.basis[j]) ? fut.basis[j]! : null };
  });
}
const BUILD: Record<string, { dir: Direction; name: string }> = {
  "1|1": { dir: "bullish", name: "long build-up" }, "1|-1": { dir: "bullish", name: "short covering" },
  "-1|1": { dir: "bearish", name: "short build-up" }, "-1|-1": { dir: "bearish", name: "long unwinding" },
};
function future(f: Frame, fl: FutureLeg[]): Signal[] {
  const out: Signal[] = [];
  for (let i = f.w; i < f.n; i++) {
    const a = fl[i - f.w]!, b = fl[i]!;
    if (!fnum(a.price) || !fnum(b.price) || !fnum(a.oi) || !fnum(b.oi) || a.oi <= 0) continue;
    const dp = b.price / a.price - 1, doi = b.oi / a.oi - 1;
    if (Math.abs(dp) < TH.futPriceMove || Math.abs(doi) < TH.futOiMove) continue;
    const build = BUILD[`${sgn(dp)}|${sgn(doi)}`]!;
    const ps = f.p.slice(i - f.w + 1, i + 1).filter(fnum);
    if (ps.length < Math.ceil(f.w / 2)) continue;
    const sum = ps.reduce((x, y) => x + y, 0), absSum = ps.reduce((x, y) => x + Math.abs(y), 0);
    if (absSum === 0 || Math.abs(sum) / absSum < TH.futConsistency) continue;
    const optDir = dirOf(sum);
    if (optDir === build.dir) continue;
    const dBasis = fnum(a.basis) && fnum(b.basis) ? b.basis - a.basis : null;
    out.push({
      id: "future", i, at: f.c[i]!.label, direction: build.dir, strength: clamp01(0.5 * (Math.abs(sum) / absSum) + 0.5 * clamp01(Math.abs(dp) / 0.003)), state: "confirmed", title: "Future against options",
      text: `The future shows ${build.name} (price ${pct(dp)}, OI ${pct(doi)}) while Smart OI over the same ${f.w * f.tf} minutes leans ${optDir}${dBasis != null ? `; basis ${dBasis >= 0 ? "+" : "−"}${Math.abs(dBasis).toFixed(1)}` : ""}. The two markets disagree.`,
      evidence: { futPrice: dp, futOi: doi, smartOiSum: sum, basisChange: dBasis },
    });
  }
  return out;
}

// ---------------------------------------------------------------- 6 zone divergence
function zone(f: Frame, sfs: (StrikeFlow | null)[]): Signal[] {
  const out: Signal[] = [];
  for (let i = f.w; i < f.n; i++) {
    const win = sfs.slice(i - f.w + 1, i + 1).filter((x): x is StrikeFlow => x != null);
    if (win.length < Math.ceil(f.w / 2)) continue;
    const sup = win.reduce((a, x) => a + x.supportDelta, 0), res = win.reduce((a, x) => a + x.resistDelta, 0);
    const den = Math.abs(sup) + Math.abs(res);
    const r = ret(f, i, f.w);
    if (den === 0 || r == null) continue;
    const z = (sup - res) / den;
    const last = sfs[i];
    const where = `${last?.supportStrike != null ? `largest put OI added at ${last.supportStrike}` : "no put OI added below spot"}, ${last?.resistStrike != null ? `largest call OI added at ${last.resistStrike}` : "no call OI added above spot"}`;
    if (r >= TH.zoneMove && z <= -TH.zoneShare) {
      out.push({ id: "zone", i, at: f.c[i]!.label, direction: "bearish", strength: clamp01(Math.abs(z)), state: "confirmed", title: "Zone divergence",
        text: `Price ${pct(r)} into a thickening ceiling: call OI above spot grew ${units(res)} against ${units(sup)} of put OI below (${where}).`, evidence: { priceChange: r, support: sup, resistance: res, zoneBalance: z } });
    } else if (r <= -TH.zoneMove && z >= TH.zoneShare) {
      out.push({ id: "zone", i, at: f.c[i]!.label, direction: "bullish", strength: clamp01(Math.abs(z)), state: "confirmed", title: "Zone divergence",
        text: `Price ${pct(r)} onto a thickening floor: put OI below spot grew ${units(sup)} against ${units(res)} of call OI above (${where}).`, evidence: { priceChange: r, support: sup, resistance: res, zoneBalance: z } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 7 momentum divergence
export function ema(xs: (number | null)[], span: number): (number | null)[] {
  const a = 2 / (span + 1);
  let cur: number | null = null;
  return xs.map((v) => { if (v == null) return cur; cur = cur == null ? v : a * v + (1 - a) * cur; return cur; });
}
function momentum(f: Frame): Signal[] {
  const out: Signal[] = [];
  const e = ema(f.p, tfp(f.tf).emaSpan);
  const h = Math.max(2, Math.floor(f.w / 2));
  for (let i = Math.max(f.w, 10); i < f.n; i++) {
    const hist = f.p.slice(0, i).filter(fnum); // the candles before this one: a spike does not raise its own yardstick
    if (hist.length < 10) continue;
    const med = median(hist)!, mad = median(hist.map((x) => Math.abs(x - med)))!;
    const scale = 1.4826 * mad;
    if (scale <= 0) continue;
    const r = ret(f, i, f.w);
    const e1 = e[i], e0 = e[i - h];
    if (r == null || e1 == null || e0 == null) continue;
    const slope = (e1 - e0) / scale; // in robust standard deviations of Smart OI per half window
    // the level matters as much as the slope: Smart OI that is still negative but less negative is calls being added more slowly, not puts being added
    if (r >= TH.momMove && slope <= -TH.momSlope && e1 < 0) {
      out.push({ id: "momentum", i, at: f.c[i]!.label, direction: "bearish", strength: clamp01(Math.abs(slope) / (TH.momSlope * 4)), state: "confirmed", title: "Momentum divergence",
        text: `Price ${pct(r)} over ${f.w * f.tf} minutes while the smoothed Smart OI is negative and falling further (${slope.toFixed(2)} robust deviations): calls are being added faster as the index rises.`, evidence: { priceChange: r, slope } });
    } else if (r <= -TH.momMove && slope >= TH.momSlope && e1 > 0) {
      out.push({ id: "momentum", i, at: f.c[i]!.label, direction: "bullish", strength: clamp01(Math.abs(slope) / (TH.momSlope * 4)), state: "confirmed", title: "Momentum divergence",
        text: `Price ${pct(r)} over ${f.w * f.tf} minutes while the smoothed Smart OI is positive and rising (+${slope.toFixed(2)} robust deviations): puts are being added faster as the index falls.`, evidence: { priceChange: r, slope } });
    }
    const p = f.p[i];
    const z = p == null ? null : (p - med) / scale;
    if (z != null && Math.abs(z) >= TH.momZ && (i === f.n - 1 || Math.abs(((f.p[i - 1] ?? 0) - med) / scale) < TH.momZ)) {
      out.push({ id: "momentum", i, at: f.c[i]!.label, direction: dirOf(z), strength: clamp01((Math.abs(z) - TH.momZ) / TH.momZ), state: "confirmed", title: "Momentum divergence",
        text: `Unusual Smart OI: ${z.toFixed(1)} robust deviations from this day's median (${units(p!)}).`, evidence: { z, smartOi: p ?? null } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- quality and composite
export function qualityOf(res: SmartOiResult): QualityFlags[] {
  const end = res.day ? spotEndFor(res.day) : null; // no index price is collected from the cash end: its absence there is the rule, not a fault
  return res.candles.map((c) => ({ gap: c.span > 1, strikes: c.strikesChanged, proxy: c.spotProxy, noSpot: !c.spot && !(end != null && c.label >= end) }));
}
export function gradeOf(q: QualityFlags[], i: number, w: number, stalled: boolean): Grade {
  const win = q.slice(Math.max(0, i - w + 1), i + 1);
  const flagged = win.filter((x) => x.gap || x.strikes || x.proxy || x.noSpot).length;
  if (stalled || flagged >= 3) return "C";
  return flagged >= 1 ? "B" : "A";
}

/** How the signals of one direction fared: ``right`` price moved the way the signal pointed, ``wrong`` it moved the other way, ``flat`` it did not move, ``pending`` the horizon has not passed yet or there is no index price to judge by. */
export interface Score { signals: number; judged: number; right: number; wrong: number; flat: number; pending: number; meanMove: number | null }
export interface Scorecard { horizonMin: number; bullish: Score; bearish: Score; neutral: number; byIndicator: { id: IndicatorId; direction: "bullish" | "bearish"; score: Score }[] }
const emptyScore = (): Score => ({ signals: 0, judged: 0, right: 0, wrong: 0, flat: 0, pending: 0, meanMove: null });

/**
 * A scorecard of the signals so far: for each burst (the start of a run of one signal), the move of the candle close ``horizon`` candles later against the close of its own candle, counted in the
 * direction the signal pointed (bullish: a rise is right; bearish: a fall is right). The move is signed, in percent. A neutral signal points nowhere and is only counted. Nothing is judged
 * before its horizon has passed or without an index price at both ends (after the cash end there is none): those are ``pending``. It describes today only and proves nothing on a few signals;
 * on a trend day a contrarian signal can be wrong many times in a row, which is what it is there to show.
 */
export function scoreBursts(bursts: readonly Burst[], closes: readonly (number | null)[], horizon: number, tf: number): Scorecard {
  const out: Scorecard = { horizonMin: horizon * tf, bullish: emptyScore(), bearish: emptyScore(), neutral: 0, byIndicator: [] };
  const sums = new Map<string, number>();
  const cell = (id: IndicatorId, direction: "bullish" | "bearish") => {
    let e = out.byIndicator.find((x) => x.id === id && x.direction === direction);
    if (!e) { e = { id, direction, score: emptyScore() }; out.byIndicator.push(e); }
    return e.score;
  };
  const add = (sc: Score, key: string, r: number | null, sign: 1 | -1) => {
    sc.signals++;
    if (r == null) { sc.pending++; return; }
    const signed = sign * r;
    sc.judged++;
    sums.set(key, (sums.get(key) ?? 0) + signed);
    if (signed > 0) sc.right++; else if (signed < 0) sc.wrong++; else sc.flat++;
  };
  for (const b of bursts) {
    if (b.direction === "neutral") { out.neutral++; continue; }
    const a = closes[b.i], z = closes[b.i + horizon];
    const r = a != null && z != null && a > 0 ? (z / a - 1) * 100 : null;
    const sign = b.direction === "bullish" ? 1 : -1;
    add(b.direction === "bullish" ? out.bullish : out.bearish, b.direction, r, sign);
    add(cell(b.id, b.direction), `${b.id}/${b.direction}`, r, sign);
  }
  for (const [sc, key] of [[out.bullish, "bullish"], [out.bearish, "bearish"]] as const) sc.meanMove = sc.judged ? (sums.get(key) ?? 0) / sc.judged : null;
  for (const e of out.byIndicator) e.score.meanMove = e.score.judged ? (sums.get(`${e.id}/${e.direction}`) ?? 0) / e.score.judged : null;
  return out;
}

export interface Burst extends Signal {
  /** how many consecutive signals of this indicator and direction this burst holds */
  count: number;
  lastI: number; lastAt: string;
}
/**
 * One entry per burst. A rolling indicator (momentum, PCR, conviction) fires on every candle for as long as its condition holds, which is one situation, not
 * thirty: signals of the same indicator and direction that follow each other within ``gap`` candles are one burst, shown at its start (the onset), with its length
 * and its last candle. The strength is the largest in the burst. Nothing is dropped from the report itself; this is only for drawing and listing.
 */
export function collapseBursts(signals: readonly Signal[], gap = 3): Burst[] {
  const out: Burst[] = [];
  const open = new Map<string, Burst>();
  for (const s of [...signals].sort((a, b) => a.i - b.i)) {
    const key = `${s.id}|${s.direction}`, cur = open.get(key);
    if (cur && s.i - cur.lastI <= gap) {
      cur.count++; cur.lastI = s.i; cur.lastAt = s.at; cur.strength = Math.max(cur.strength, s.strength);
      continue;
    }
    const b: Burst = { ...s, count: 1, lastI: s.i, lastAt: s.at };
    open.set(key, b);
    out.push(b);
  }
  return out.sort((a, b) => a.i - b.i);
}

/** The eighth indicator: how many of the seven agree. A direction needs at least three active and a lead of two over the other side. */
export function composeOf(readings: Reading[], grade: Grade): Composite {
  const bull = readings.filter((r) => r.active && r.direction === "bullish").length, bear = readings.filter((r) => r.active && r.direction === "bearish").length;
  const agree = Math.max(bull, bear);
  const dir: Direction = agree >= TH.composite.minAgree && Math.abs(bull - bear) >= TH.composite.minLead ? (bull > bear ? "bullish" : "bearish") : "neutral";
  return {
    direction: dir, bullish: bull, bearish: bear, agree, grade,
    text: dir === "neutral" ? (bull + bear === 0 ? "No divergence is active." : `Mixed: ${bull} bullish and ${bear} bearish divergence${bull + bear === 1 ? "" : "s"} active.`) : `${agree} of ${readings.length} indicators agree ${dir}.`,
  };
}

export function analyseSmartOi(res: SmartOiResult, opts: { strikeFlow?: (StrikeFlow | null)[]; future?: FutureLeg[]; asOf?: number } = {}): DivergenceReport {
  const f = frameOf(res);
  const sfs = opts.strikeFlow ?? null, fl = opts.future ?? null;
  const hasFut = !!fl && fl.some((x) => x.price != null);
  const hasStrikes = !!sfs && sfs.some((x) => x != null);
  let signals: Signal[] = [
    ...flow(f), ...conviction(f), ...pcr(f), ...momentum(f),
    ...(hasStrikes ? [...writing(f, sfs!), ...zone(f, sfs!)] : []),
    ...(hasFut ? future(f, fl!) : []),
  ].sort((a, b) => a.i - b.i);
  if (opts.asOf != null) signals = signals.filter((s) => s.i <= opts.asOf!); // replay: nothing after the replay candle
  const last = Math.max(0, f.n - 1);
  const live = (s: Signal) => s.i > last - f.w && s.state === "confirmed";
  const ids: IndicatorId[] = ["flow", "writing", "conviction", "pcr", "future", "zone", "momentum"];
  const readings: Reading[] = ids.map((id) => {
    const cur = [...signals].reverse().find((s) => s.id === id && live(s));
    return cur
      ? { id, active: true, direction: cur.direction, strength: cur.strength, at: cur.at, text: cur.text }
      : { id, active: false, direction: "neutral", strength: 0, at: null, text: id === "writing" && !hasStrikes ? "No stored per-strike series." : id === "zone" && !hasStrikes ? "No stored per-strike series." : id === "future" && !hasFut ? "No stored NIFTY future series." : "No divergence in the last window." };
  });
  const q = qualityOf(res);
  const composite = composeOf(readings, gradeOf(q, last, f.w, res.stalls.length > 0));
  return { day: res.day, timeframe: res.timeframe, candles: f.n, signals, readings, composite, quality: q, missing: { strikes: !hasStrikes, future: !hasFut } };
}

/** Signals that start on the same candle become one marker: the direction they share, or neutral when they disagree. */
export function markerGroups(bursts: readonly Burst[]): { direction: Direction; lead: Burst; all: Burst[] }[] {
  const by = new Map<number, Burst[]>();
  for (const b of bursts) by.set(b.i, [...(by.get(b.i) ?? []), b]);
  return [...by.values()].map((all) => {
    const dirs = new Set(all.map((x) => x.direction).filter((d) => d !== "neutral"));
    const direction: Direction = dirs.size === 1 ? [...dirs][0]! : "neutral";
    return { direction, lead: all.find((x) => x.direction === direction) ?? all[0]!, all };
  });
}
