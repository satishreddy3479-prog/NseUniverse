/**
 * Premium Change: what drove the change of an option premium, from the stored one-minute samples.
 *
 * The change of a straddle (call + put of one strike) over one window is split into three parts that always add up to the real change:
 *   decay  the price one window later at the same spot and the same implied volatility, minus the price now (only time passes)
 *   spot   the price at the new spot (same volatility, new time) minus the price at the old spot: NIFTY moving (delta and gamma together)
 *   vol    the real new price minus the model price at the new spot: the change of implied volatility AND everything the model does not explain
 *          (quote noise, a wrong forward, skew moving). It is a remainder, and the page says so.
 * Black-76 with the forward read from put-call parity near the money (the same forward and rate the Greeks tools use). A contract with no usable price or no implied volatility
 * is skipped and counted, never zero-filled.
 */
import { isSessionMs } from "./analytics";
import { RISK_FREE_RATE } from "./assumptions";
import { black76, carryFromForward, expiryEnd, impliedForward, impliedVol } from "./optionModel";
import { sessionOpenMin } from "./session";
import type { StrikeSeries } from "./types";

const YEAR_MS = 365 * 86_400_000;
const IST_MS = 330 * 60_000;

export interface Split { decay: number; spot: number; vol: number; total: number }

export interface SplitInput {
  strike: number;
  /** premiums at the start and at the end of the window */
  ce0: number; pe0: number; ce1: number; pe1: number;
  /** forward at the start (put-call parity), spots and the two instants (ms) */
  f0: number; spot0: number; spot1: number; t0Ms: number; t1Ms: number;
  expiry: string;
  rate?: number;
}

/** The three parts of the change of one straddle over one window, or null when time is up or no volatility fits a starting price. */
export function splitStraddle(i: SplitInput): Split | null {
  const r = i.rate ?? RISK_FREE_RATE;
  const end = expiryEnd(i.expiry);
  const T0 = (end - i.t0Ms) / YEAR_MS, T1 = (end - i.t1Ms) / YEAR_MS;
  if (!(T0 > 0) || !(T1 > 0) || !(i.f0 > 0)) return null;
  const carry = carryFromForward(i.spot0, i.f0, i.expiry, i.t0Ms);
  if (carry == null) return null;
  const f1 = i.spot1 * Math.exp(carry * T1); // the forward moves with the spot, at the carry the market showed at the start
  const out = { decay: 0, spot: 0, vol: 0 };
  for (const [type, p0, p1] of [["CE", i.ce0, i.ce1], ["PE", i.pe0, i.pe1]] as const) {
    if (![p0, p1].every((x) => Number.isFinite(x) && x > 0)) return null;
    const iv = impliedVol(type, p0, i.f0, i.strike, T0, r);
    if (iv == null) return null;
    const a = black76(type, i.f0, i.strike, T1, iv, r); // time has passed, nothing else
    const b = black76(type, f1, i.strike, T1, iv, r); // and the spot has moved
    out.decay += a - p0;
    out.spot += b - a;
    out.vol += p1 - b; // what is left
  }
  return { ...out, total: i.ce1 + i.pe1 - (i.ce0 + i.pe0) };
}

export interface ChangeWindow {
  /** end of the window (ms) and its IST day */
  t: number;
  day: string;
  spot: number;
  /** spot at the start of the window */
  spot0: number;
  /** the strike that was at the money at the end of the window and its straddle price then */
  atmStrike: number;
  straddle: number | null;
  atm: Split | null;
  /** every strike of the series that could be split, null when it could not */
  strikes: Record<number, Split | null>;
}

export interface ChangeResult { windows: ChangeWindow[]; minutes: number; skippedWindows: number; unsplit: number }

const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = (ms: number) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/**
 * The windows of ``minutes`` minutes through the session(s) of a stored strike series. A slot ends on a multiple of ``minutes`` counted from the open (09:20, 09:25, ... for 5 minutes) and
 * holds the samples after the previous boundary up to and including it; its last sample stands for the boundary. A window runs from one boundary to the next, so windows do not overlap, and
 * is named by the boundary it ends on. A window across a gap in the stored samples is skipped and counted (its change would cover more than one window).
 */
export function changeWindows(res: StrikeSeries, expiry: string, minutes: number, rate = RISK_FREE_RATE): ChangeResult {
  const open = sessionOpenMin();
  type S = { t: number; spot: number; i: number; slot: number; day: string };
  const lastInSlot = new Map<string, S>();
  res.times.forEach((iso, i) => {
    const t = new Date(iso).getTime(), spot = res.spot[i];
    if (!isSessionMs(t) || spot == null || !Number.isFinite(spot)) return;
    const slot = Math.ceil((istMinute(t) - open) / minutes), day = istDay(t);
    lastInSlot.set(`${day}|${slot}`, { t, spot, i, slot, day }); // times run forward: the last one written is the newest of the slot
  });
  const samples = [...lastInSlot.values()].sort((a, b) => a.t - b.t);
  const strikes = [...res.strikes].sort((a, b) => a - b);
  const price = (side: "ce" | "pe", k: number, i: number) => (side === "ce" ? res.ce_price : res.pe_price)[String(k)]?.[i] ?? null;
  const rows = (i: number) => strikes.map((k) => ({ strike: k, call: price("ce", k, i), put: price("pe", k, i) }));
  const out: ChangeWindow[] = [];
  let skipped = 0, unsplit = 0;
  for (let n = 1; n < samples.length; n++) {
    const a = samples[n - 1]!, b = samples[n]!;
    if (a.day !== b.day || b.slot !== a.slot + 1) { if (a.day === b.day) skipped++; continue; }
    const fwd = impliedForward(rows(a.i), a.spot, expiry, a.t, rate);
    let nearest = strikes[0];
    for (const k of strikes) if (nearest == null || Math.abs(k - b.spot) < Math.abs(nearest - b.spot)) nearest = k;
    if (nearest == null) continue;
    const per: Record<number, Split | null> = {};
    for (const k of strikes) {
      const [ce0, pe0, ce1, pe1] = [price("ce", k, a.i), price("pe", k, a.i), price("ce", k, b.i), price("pe", k, b.i)];
      if (fwd == null || ce0 == null || pe0 == null || ce1 == null || pe1 == null) { per[k] = null; unsplit++; continue; }
      per[k] = splitStraddle({ strike: k, ce0, pe0, ce1, pe1, f0: fwd.forward, spot0: a.spot, spot1: b.spot, t0Ms: a.t, t1Ms: b.t, expiry, rate });
      if (per[k] == null) unsplit++;
    }
    const ce = price("ce", nearest, b.i), pe = price("pe", nearest, b.i);
    out.push({ t: b.t, day: b.day, spot: b.spot, spot0: a.spot, atmStrike: nearest, straddle: ce != null && pe != null ? ce + pe : null, atm: per[nearest] ?? null, strikes: per });
  }
  return { windows: out, minutes, skippedWindows: skipped, unsplit };
}

export interface Running { decay: number | null; spot: number | null; vol: number | null; total: number | null }

/**
 * Running totals of the ATM straddle's parts from the first window of each day. The strike at the money changes through the day, so this adds up the changes of whichever straddle was
 * at the money in each window: it is not the price of one straddle. A window that could not be split adds nothing and shows as a gap (null) at its own position.
 */
export function runningTotals(ws: readonly ChangeWindow[]): Running[] {
  const out: Running[] = [];
  let sum = { decay: 0, spot: 0, vol: 0, total: 0 }, day = "";
  for (const w of ws) {
    if (w.day !== day) { day = w.day; sum = { decay: 0, spot: 0, vol: 0, total: 0 }; }
    if (w.atm == null) { out.push({ decay: null, spot: null, vol: null, total: null }); continue; }
    sum = { decay: sum.decay + w.atm.decay, spot: sum.spot + w.atm.spot, vol: sum.vol + w.atm.vol, total: sum.total + w.atm.total };
    out.push({ ...sum });
  }
  return out;
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
export const rupees = (v: number) => `${v >= 0 ? "+" : "−"}₹${r1(Math.abs(v))}`;

/** The sentence under the controls: what the ATM straddle did in the chosen window and what drove it. Null when the window could not be split. */
export function readout(w: ChangeWindow, minutes: number, hhmm: string): string | null {
  const a = w.atm;
  if (a == null) return null;
  const move = w.spot - w.spot0;
  const price = w.straddle == null ? "" : ` (₹${r1(w.straddle)})`;
  return `At ${hhmm} the ${w.atmStrike} straddle${price} went ${a.total >= 0 ? "up" : "down"} by ₹${r1(Math.abs(a.total))} in ${minutes} minute${minutes === 1 ? "" : "s"} (NIFTY ${move >= 0 ? "+" : "−"}${Math.abs(Math.round(move))} points): ${rupees(a.decay)} from time decay, ${rupees(a.spot)} from NIFTY moving, ${rupees(a.vol)} from volatility and the rest.`;
}
