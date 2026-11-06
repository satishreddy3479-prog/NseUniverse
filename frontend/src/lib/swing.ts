// Pure helpers for the Swing page: formatting, staleness, filtering, sorting and CSV export.
// Missing values stay missing (em dash), never zero.
import { compactIN } from "./analytics";
import { MISSING } from "./format";
import type { SwingTrade } from "./types";

export type Basis = "gross" | "net";

export const BASIS_LABEL: Record<Basis, string> = { gross: "Before costs", net: "After costs" };

export const rupees = (v: number | null | undefined): string => (v == null ? MISSING : `₹${compactIN(v)}`);

const sign = (v: number, body: string): string => (v > 0 ? `+${body}` : v < 0 ? `−${body}` : body);

export function pct(v: number | null | undefined, digits = 1): string {
  return v == null ? MISSING : sign(v, `${Math.abs(v).toFixed(digits)}%`);
}

export function plain(v: number | null | undefined, digits = 2): string {
  return v == null ? MISSING : v.toFixed(digits).replace("-", "−");
}

export const signedRupees = (v: number | null | undefined): string =>
  v == null ? MISSING : sign(v, `₹${compactIN(Math.abs(v))}`);

/** Calendar days between the last bar in the report and `now` (IST dates). */
export function reportAgeDays(dataThrough: string, now: Date = new Date()): number {
  const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  return Math.round((Date.parse(ist) - Date.parse(dataThrough)) / 86_400_000);
}

/** More than 3 calendar days covers a weekend; beyond that a session was missed. */
export const isStale = (dataThrough: string, now: Date = new Date()): boolean => reportAgeDays(dataThrough, now) > 3;

const EXIT: Record<string, string> = {
  D1_FAIL_CLOSE: "Day-1 cut: closed below pivot",
  D1_REJECT_WICK: "Day-1 cut: rejection wick",
  D1_STOP: "Day-1 stop-out",
  STOP: "Stop (initial, breakeven or trailing)",
  STOP_GAP: "Stop, gapped through at the open",
  OPEN_AT_END: "Still open at the end (marked to market)",
};
export const exitLabel = (r: string): string => EXIT[r] ?? r;

export type SortDir = "asc" | "desc";

/** Stable sort that always puts missing values last, whatever the direction. */
export function sortBy<T>(rows: readonly T[], key: (r: T) => number | string | null | undefined, dir: SortDir): T[] {
  const m = dir === "asc" ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => {
      const an = a.k == null, bn = b.k == null;
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : String(a.k).localeCompare(String(b.k));
      return c !== 0 ? c * m : a.i - b.i;
    })
    .map((x) => x.r);
}

export interface TradeFilter { reason: string; year: string; archetype: string; query: string }
export const NO_FILTER: TradeFilter = { reason: "", year: "", archetype: "", query: "" };

export function filterTrades(trades: readonly SwingTrade[], f: TradeFilter): SwingTrade[] {
  const q = f.query.trim().toLowerCase();
  return trades.filter((t) =>
    (!f.reason || t.reason === f.reason) &&
    (!f.year || t.entry_date.startsWith(f.year)) &&
    (!f.archetype || t.archetype === f.archetype) &&
    (!q || t.symbol.toLowerCase().includes(q)));
}

const CSV_COLS: { head: string; get: (t: SwingTrade) => string | number | null }[] = [
  { head: "symbol", get: (t) => t.symbol }, { head: "sector_index", get: (t) => t.sector },
  { head: "archetype", get: (t) => t.archetype }, { head: "score", get: (t) => t.score },
  { head: "signal_date", get: (t) => t.signal_date }, { head: "entry_date", get: (t) => t.entry_date },
  { head: "entry_price", get: (t) => t.entry }, { head: "pivot", get: (t) => t.pivot },
  { head: "initial_stop", get: (t) => t.initial_sl }, { head: "shares", get: (t) => t.shares },
  { head: "exit_date", get: (t) => t.exit_date }, { head: "exit_price", get: (t) => t.exit },
  { head: "exit_reason", get: (t) => t.reason }, { head: "pnl_before_costs_inr", get: (t) => t.pnl },
  { head: "return_pct", get: (t) => t.return_pct }, { head: "r_multiple", get: (t) => t.r_mult },
  { head: "holding_days", get: (t) => t.hold_days },
];

const cell = (v: string | number | null): string => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function tradesToCsv(trades: readonly SwingTrade[]): string {
  const lines = [CSV_COLS.map((c) => c.head).join(",")];
  for (const t of trades) lines.push(CSV_COLS.map((c) => cell(c.get(t))).join(","));
  return `${lines.join("\n")}\n`;
}

export const SECTOR_NAME: Record<string, string> = {
  CNXAUTO: "Auto", NSEBANK: "Private banks & NBFC", CNXPSUBANK: "PSU banks", CNXENERGY: "Energy",
  CNXFMCG: "FMCG & consumer", CNXINFRA: "Infrastructure & capital goods", CNXIT: "IT",
  CNXMETAL: "Metals", CNXPHARMA: "Pharma & healthcare", CNXREALTY: "Realty", CNXPSE: "PSE & power",
};

/** The scanner's last result in plain words (the raw value is "state" or "state: detail"). */
export function resultText(raw: string): string {
  const [state = "", ...rest] = raw.split(": ");
  const detail = rest.join(": ");
  switch (state) {
    case "ok": return "Done: the session was settled and the next orders queued";
    case "up_to_date": return "Already up to date with the latest finished session";
    case "data_unavailable": return `Data not available yet${detail ? ` (${detail})` : ""}; it will retry`;
    case "error": return `Error${detail ? ` (${detail})` : ""}; it will retry`;
    case "busy": return "A scan was already running";
    case "not run yet": return "Not run yet";
    default: return raw;
  }
}

const LIVE_STATE: Record<string, string> = {
  waiting: "Waiting for the trigger", triggered: "Triggered: would be bought", gap_skip: "Skipped: gapped above the limit",
  volume_short: "Price through the trigger, volume still short", volume_early: "Price through the trigger, too early to judge volume",
  stale_queue: "Not checked: queued for an earlier session", no_data: "No live price yet", stale: "Price is stale",
  holding: "Holding", stop_hit: "Stop breached: would be sold",
};
export const liveStateLabel = (s: string): string => LIVE_STATE[s] ?? s;

const LIVE_EVENT: Record<string, string> = {
  entry_trigger: "Would buy: price through the trigger on enough volume", entry_gap_skip: "Would skip: opened above the no-chase limit",
  stop_hit: "Would sell: stop breached", target_1_8r: "Reached 1.8R: the stop moves to breakeven at the close",
  target_2_5r: "Reached 2.5R: the trailing stop starts at the close",
};
export const liveEventLabel = (k: string): string => LIVE_EVENT[k] ?? k;

/** Percent distance from the live price to a level (positive = the level is above the price). */
export const pctTo = (level: number | null | undefined, ltp: number | null | undefined): number | null =>
  level == null || ltp == null || ltp <= 0 ? null : (level / ltp - 1) * 100;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "05 Nov 2026 09:37 IST" (with seconds when asked): date and time in IST, the same on every device. */
export function fmtStamp(iso: string | null | undefined, seconds = false): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600_000);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${seconds ? `:${p(d.getUTCSeconds())}` : ""} IST`;
}


/**
 * The engine's cooldown (backend/app/swing/engine.py): an order is skipped when `session ordinal - ordinal of the stock's last exit`
 * is below the cooldown. The scan queues every stock that passes the score and the gates, whatever its history, so a stock cut
 * on day 1 can be queued again at once and is then skipped next session. Returns how many sessions it will still be skipped
 * for, counting from the next session, or null when it is free to fill.
 */
export function cooldownLeft(symbol: string, trades: { symbol: string; exit_no?: number }[], nextNo: number | null, cooldown: number): { sessions: number; lastExitNo: number } | null {
  if (nextNo == null) return null;
  const exits = trades.filter((t) => t.symbol === symbol && t.exit_no != null).map((t) => t.exit_no as number);
  if (exits.length === 0) return null;
  const last = Math.max(...exits);
  const left = cooldown - (nextNo - last);
  return left > 0 ? { sessions: left, lastExitNo: last } : null;
}
