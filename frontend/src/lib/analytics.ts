// Pure analytics over option-chain rows. Missing values are skipped and counted, never treated as 0.
import type { OptionChainRow, OptionQuote } from "./types";
import { isHoliday, sessionCloseMin, sessionLabel, sessionOpenMin } from "./session";

export interface Totals {
  ceOi: number | null;
  peOi: number | null;
  ceOiChange: number | null;
  peOiChange: number | null;
  ceVolume: number | null;
  peVolume: number | null;
  strikes: number;
  /** Contracts left out of a sum because the value was missing. */
  missing: { oi: number; oiChange: number; volume: number };
}

function addUp(values: (number | null | undefined)[]): { sum: number | null; missing: number } {
  let sum = 0;
  let have = 0;
  let missing = 0;
  for (const v of values) {
    if (v == null) missing++;
    else {
      sum += v;
      have++;
    }
  }
  return { sum: have ? sum : null, missing };
}

export function computeTotals(rows: OptionChainRow[]): Totals {
  const ce = rows.map((r) => r.call);
  const pe = rows.map((r) => r.put);
  const pick = (qs: (OptionQuote | null)[], k: "oi" | "oi_change" | "volume") =>
    addUp(qs.map((q) => (q ? q[k] : null)));
  const ceOi = pick(ce, "oi"), peOi = pick(pe, "oi");
  const ceCh = pick(ce, "oi_change"), peCh = pick(pe, "oi_change");
  const ceVol = pick(ce, "volume"), peVol = pick(pe, "volume");
  return {
    ceOi: ceOi.sum, peOi: peOi.sum, ceOiChange: ceCh.sum, peOiChange: peCh.sum,
    ceVolume: ceVol.sum, peVolume: peVol.sum, strikes: rows.length,
    missing: { oi: ceOi.missing + peOi.missing, oiChange: ceCh.missing + peCh.missing, volume: ceVol.missing + peVol.missing },
  };
}

/** Put-call ratio = put total / call total. Null when either total is missing or the denominator is 0. */
export function pcr(putTotal: number | null, callTotal: number | null): number | null {
  if (putTotal == null || callTotal == null || callTotal <= 0) return null;
  return putTotal / callTotal;
}

export interface MaxPain {
  strike: number;
  /** Total payout (INR) if the expiry settles at `strike`, summed over the valid strikes. */
  payout: number;
  /** Strikes excluded because OI was missing on either side. */
  excludedStrikes: number;
  usedStrikes: number;
}

/**
 * Max pain: the listed strike at which option buyers' total intrinsic value at expiry is smallest.
 *   payout(S) = sum over strikes K of  CE_OI(K) * max(0, S - K)  +  PE_OI(K) * max(0, K - S)
 * OI is in units (already contracts x lot size), so the payout is in INR. Candidate settlement
 * prices are the listed strikes. Strikes where either side's OI is missing are excluded entirely.
 * This is a description of OI positioning, not a forecast of where the index will settle.
 */
export function maxPain(rows: OptionChainRow[]): MaxPain | null {
  const valid = rows.filter((r) => r.call?.oi != null && r.put?.oi != null);
  if (valid.length === 0) return null;
  let best: { strike: number; payout: number } | null = null;
  for (const s of valid) {
    let payout = 0;
    for (const r of valid) {
      payout += r.call!.oi! * Math.max(0, s.strike - r.strike);
      payout += r.put!.oi! * Math.max(0, r.strike - s.strike);
    }
    if (best === null || payout < best.payout) best = { strike: s.strike, payout };
  }
  return { ...best!, excludedStrikes: rows.length - valid.length, usedStrikes: valid.length };
}

export interface Straddle {
  strike: number;
  call: number;
  put: number;
  premium: number;
}

/** ATM straddle = ATM call LTP + ATM put LTP. Null unless both prices exist. */
export function atmStraddle(rows: OptionChainRow[], atmStrike: number | null): Straddle | null {
  if (atmStrike == null) return null;
  const r = rows.find((x) => x.strike === atmStrike);
  const c = r?.call?.ltp, p = r?.put?.ltp;
  if (c == null || p == null) return null;
  return { strike: atmStrike, call: c, put: p, premium: c + p };
}

/** ATM plus `eachSide` listed strikes on both sides ("all" keeps every strike). */
export function universeRows(rows: OptionChainRow[], atmStrike: number | null, eachSide: number | "all"): OptionChainRow[] {
  if (eachSide === "all" || atmStrike == null) return rows;
  const i = rows.findIndex((r) => r.strike === atmStrike);
  if (i < 0) return rows;
  return rows.slice(Math.max(0, i - eachSide), i + eachSide + 1);
}

/** Indian compact notation: 1,23,456 -> 1.23 L ; 1,23,45,678 -> 1.23 Cr. */
export function compactIN(v: number | null | undefined): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)} K`;
  return `${sign}${Math.round(a)}`;
}

// ---------------------------------------------------------------- time ranges for stored samples

export type TsRange = "30m" | "1h" | "session" | "all";
export const TS_RANGES: { id: TsRange; label: string; title: string }[] = [
  { id: "30m", label: "30 min", title: "The 30 minutes up to the newest stored sample" },
  { id: "1h", label: "1 hour", title: "The hour up to the newest stored sample" },
  { id: "session", label: "Session", get title() { return `Today's session, ${sessionLabel()} IST (the last session when the market is closed)`; } },
  { id: "all", label: "All", title: "Every stored sample returned for this expiry" },
];

const IST_MS = 5.5 * 3600_000;
const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = (ms: number) => Math.floor((((ms + IST_MS) % 86400_000) + 86400_000) % 86400_000 / 60_000);

/** True for a moment inside a trading session: a weekday that is not an exchange holiday, 09:15 to the close, IST. */
export function isSessionMs(ms: number): boolean {
  const dow = new Date(ms + IST_MS).getUTCDay();
  const m = istMinute(ms);
  return dow !== 0 && dow !== 6 && !isHoliday(istDay(ms)) && m >= sessionOpenMin() && m <= sessionCloseMin();
}
/** Open and close (ms) of the IST day containing `ms`. */
export function sessionBoundsOf(ms: number): { min: number; max: number } {
  const [y, m, d] = istDay(ms).split("-").map(Number) as [number, number, number];
  const dayStart = Date.UTC(y, m - 1, d) - IST_MS; // IST midnight
  return { min: dayStart + sessionOpenMin() * 60_000, max: dayStart + sessionCloseMin() * 60_000 };
}

/**
 * Restrict stored observations to a range. Only samples taken during a session (weekday, 09:15 to the close) are
 * drawn: a chain fetched overnight or at the weekend holds the last close and would draw a flat line across the night.
 * Ranges are measured from the newest in-session sample, so they also work after the close. "session" = the IST day of
 * that sample, with the axis fixed to the session (`bounds`). If nothing was ever sampled in session, every sample is
 * returned with a note and `afterHoursOnly` set.
 */
export function rangeObservations<T extends { retrieved_at: string }>(obs: T[], range: TsRange): { rows: T[]; note: string | null; bounds: { min: number; max: number } | null; afterHoursOnly: boolean } {
  const none = { bounds: null, afterHoursOnly: false };
  if (obs.length === 0) return { rows: obs, note: null, ...none };
  const ms = (o: T) => new Date(o.retrieved_at).getTime();
  const live = obs.filter((o) => isSessionMs(ms(o)));
  if (live.length === 0) return { rows: obs, note: `No sample was taken during ${sessionLabel()} IST; showing the after-hours samples that are stored.`, bounds: null, afterHoursOnly: true };
  const newest = Math.max(...live.map(ms));
  if (range === "all") return { rows: live, note: null, ...none };
  if (range === "30m" || range === "1h") {
    const from = newest - (range === "30m" ? 30 : 60) * 60_000;
    return { rows: live.filter((o) => ms(o) >= from), note: null, ...none };
  }
  const day = istDay(newest);
  return { rows: live.filter((o) => istDay(ms(o)) === day), note: null, bounds: sessionBoundsOf(newest), afterHoursOnly: false };
}

// ---------- OI by window (Last 3 min ... All) ----------

export type OiMode = "both" | "change" | "total";
export const OI_MODES: { id: OiMode; label: string; title: string }[] = [
  { id: "both", label: "OI change + total", title: "Total OI per strike, split into the part that was already there, the increase and the decrease over the window" },
  { id: "change", label: "OI change", title: "Only the change in OI over the window (negative = OI was removed)" },
  { id: "total", label: "Total OI", title: "Total OI per strike now" },
];
export interface OiWindow { id: string; label: string; minutes: number | null }
/** minutes = null means "since the first stored sample of the session" (the backend's session_open baseline). */
export const OI_WINDOWS: OiWindow[] = [
  { id: "3m", label: "Last 3 min", minutes: 3 }, { id: "5m", label: "Last 5 min", minutes: 5 }, { id: "10m", label: "Last 10 min", minutes: 10 },
  { id: "15m", label: "Last 15 min", minutes: 15 }, { id: "30m", label: "Last 30 min", minutes: 30 }, { id: "1h", label: "Last 1 hr", minutes: 60 },
  { id: "2h", label: "Last 2 hr", minutes: 120 }, { id: "3h", label: "Last 3 hr", minutes: 180 }, { id: "all", label: "All", minutes: null },
];

/** The instant the window starts: the newest stored sample minus the window length. */
export function windowStartIso(newestIso: string, minutes: number): string {
  return new Date(new Date(newestIso).getTime() - minutes * 60_000).toISOString();
}

/**
 * The instant the time slots count back from. While the session is running (or when nothing is stored for the day
 * inside 09:15-15:40 IST) it is the newest stored sample; after the close (even past midnight) it is the last sample taken during the
 * session, so "Last 30 min" shows the final half hour of trading rather than an unchanged after-hours chain.
 */
export function windowEndIso(sampleIsos: string[]): string | null {
  if (!sampleIsos.length) return null;
  const IST = 330, OPEN = sessionOpenMin(), CLOSE = sessionCloseMin();
  const parts = (iso: string) => {
    const m = Math.floor(new Date(iso).getTime() / 60_000) + IST;
    return { day: Math.floor(m / 1440), min: ((m % 1440) + 1440) % 1440 };
  };
  const newest = sampleIsos[sampleIsos.length - 1]!;
  const inSession = (iso: string) => { const m = parts(iso).min; return m >= OPEN && m <= CLOSE; };
  if (inSession(newest)) return newest;
  // newest is after hours (possibly past midnight IST): use the latest sample taken during any session
  let best: string | null = null;
  for (const iso of sampleIsos) if (inSession(iso)) best = iso;
  return best ?? newest;
}

export interface OiWindowStats {
  ceOi: number | null; peOi: number | null; ceChange: number | null; peChange: number | null;
  pcr: number | null; pcrBaseline: number | null; pcrChange: number | null;
  /** put OI change / call OI change; only defined when the call OI change is positive. */
  pcrOiChange: number | null; pcrOiChangeNote: string | null;
}

const ratio = (a: number | null, b: number | null): number | null => (a == null || b == null || b <= 0 ? null : a / b);

/** Totals over the strikes shown and the PCR figures that go with them. Nothing missing is turned into zero. */
export function oiWindowStats(t: { ce_oi: number | null; pe_oi: number | null; ce_change: number | null; pe_change: number | null }): OiWindowStats {
  const baseCe = t.ce_oi != null && t.ce_change != null ? t.ce_oi - t.ce_change : null;
  const basePe = t.pe_oi != null && t.pe_change != null ? t.pe_oi - t.pe_change : null;
  const pcr = ratio(t.pe_oi, t.ce_oi), pcrBaseline = ratio(basePe, baseCe);
  let note: string | null = null;
  let pcrOiChange: number | null = null;
  if (t.ce_change == null || t.pe_change == null) note = "no baseline OI for the window";
  else if (t.ce_change <= 0) note = "call OI did not increase, so the ratio is not meaningful";
  else pcrOiChange = t.pe_change / t.ce_change;
  return { ceOi: t.ce_oi, peOi: t.pe_oi, ceChange: t.ce_change, peChange: t.pe_change, pcr, pcrBaseline,
    pcrChange: pcr != null && pcrBaseline != null ? pcr - pcrBaseline : null, pcrOiChange, pcrOiChangeNote: note };
}
