/** The strike premium answer (GET /api/intelligence/strike-premium): what moved the price of one contract, in points of premium for one lot of it. All figures are the server's. */

export const STRIKE_PARTS = [
  { key: "theta", name: "Time (theta)" },
  { key: "vega", name: "Volatility (vega)" },
  { key: "delta", name: "NIFTY (delta)" },
  { key: "gamma", name: "Convexity (gamma)" },
  { key: "cross", name: "Vanna and volga" },
  { key: "other", name: "Other" },
] as const;
export type StrikePartKey = (typeof STRIKE_PARTS)[number]["key"];
export type Parts = Record<StrikePartKey | "actual", number>;
export type Contract = "straddle" | "call" | "put";
export interface Driver { name: "time" | "volatility" | "NIFTY" | "other"; value: number }
export interface LadderSide { price: number | null; change: number | null; parts: Parts | null; driver: Driver | null; complete: boolean }
export interface LadderRow { strike: number; atm: boolean; call: LadderSide; put: LadderSide }
export interface GreeksNow { strike: number; delta: number; gamma: number; theta_day: number; vega_pt: number; iv_pct: number }
export interface StrikePremiumData {
  status: "ok" | "unavailable";
  message?: string;
  session?: string;
  expiry?: string;
  strike?: number;
  strike_now?: number | null;
  strikes?: number[];
  mode?: "fixed" | "atm";
  contract?: Contract;
  window?: number | null;
  bucket?: number;
  lot_size?: number;
  rate_assumed: number;
  note?: string;
  skipped_steps?: number;
  series?: { t: string[]; spot: (number | null)[]; price: (number | null)[]; cum: Record<StrikePartKey | "actual", (number | null)[]> };
  bars?: ({ t: string } & Parts)[];
  summary?: { from: string; to: string; minutes: number; steps: number; price_start: number | null; price_end: number | null; parts: Parts | null; real_change: number | null; driver: Driver; nifty_start: number | null; nifty_end: number | null };
  ladder?: LadderRow[];
  greeks_now?: GreeksNow | null;
}

const sgn = (v: number, d = 1) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(d)}`;
export const rupee = (v: number) => `${v < 0 ? "−" : "+"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`;
export const sg = (v: number | null | undefined, d = 1) => (v == null ? "—" : sgn(v, d));

/** Hours and minutes in IST of an ISO time. */
export const hhmm = (iso: string): string => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);

const CONTRACT_NAME: Record<Contract, string> = { straddle: "straddle", call: "call", put: "put" };

/** The sentence at the top: what the contract did over the window and what drove it, in plain words (volatility = vega and the cross terms; NIFTY moving = delta and gamma). */
export function readout(d: StrikePremiumData): string | null {
  const s = d.summary;
  if (!s || !s.parts || s.price_start == null || s.price_end == null || d.contract == null || d.lot_size == null) return null;
  const p = s.parts;
  const parts = `Time ${sgn(p.theta)}, volatility ${sgn(p.vega + p.cross)}, NIFTY moving ${sgn(p.delta + p.gamma)}, other ${sgn(p.other)}.`;
  if (d.mode === "atm") {
    // the line of the at-the-money price jumps when the strike changes; the parts are measured on one contract at a time, so they add up to the roll-adjusted change
    return `The at-the-money ${CONTRACT_NAME[d.contract]}, followed as NIFTY moves, ${hhmm(s.from)} to ${hhmm(s.to)}: ${sgn(p.actual)} points on the contract held at each step (${rupee(p.actual * d.lot_size)} per lot). ${parts}`;
  }
  const change = s.price_end - s.price_start;
  return `The ${d.strike} ${CONTRACT_NAME[d.contract]}, ${hhmm(s.from)} to ${hhmm(s.to)}: its price ${change < 0 ? "fell" : "rose"} from ${s.price_start.toFixed(1)} to ${s.price_end.toFixed(1)} (${sgn(change)} points, ${rupee(change * d.lot_size)} per lot). ${parts}`;
}

/** Where a driver chip belongs in the table: the chip's wording. */
export const driverText = (d: Driver | null): string => (d == null ? "—" : `${d.name === "NIFTY" ? "NIFTY" : d.name} ${sgn(d.value)}`);
