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
