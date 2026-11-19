/** Types of the Entry Lab answer (`/api/intelligence/entry-lab`): short ATM straddle rules replayed on the recorded sessions. Past days, in-sample: a description, not a forecast. */

export interface EntryLabParams {
  entry: string;
  exit: string;
  stop: number | null;
  target: number | null;
  roll: number | null;
  cost: number;
  /** gates made of range-expansion signals: the day is not traded when the signals at the entry minute are above these limits */
  maxGap: number | null;
  maxRange: number | null;
  maxEff: number | null;
  skipBreak: boolean;
  /** gates made of the overnight context and the calendar: GIFT Nifty's overnight move, high-importance events in the hold or overnight */
  maxGift: number | null;
  skipEventsHold: boolean;
  skipEventsOvernight: boolean;
}

export const DEFAULT_RULE: EntryLabParams = { entry: "09:45", exit: "15:15", stop: null, target: null, roll: null, cost: 2, maxGap: null, maxRange: null, maxEff: null, skipBreak: false, maxGift: null, skipEventsHold: false, skipEventsOvernight: false };

/** What was known at the entry minute (null = could not be formed from the stored minutes). */
export interface Signals {
  minutes: number | null; gap_pts: number | null; gap_pct: number | null; gap_ratio: number | null; range_so_far: number | null; range_ratio: number | null;
  or_break: "up" | "down" | null; eff30: number | null; acc: number | null; premium_pct: number | null;
  /** overnight context and calendar (absent when nothing was recorded for the day; null = unknown, never zero) */
  gift_move_pct?: number | null; es_move_pct?: number | null; nq_move_pct?: number | null; brent_move_pct?: number | null; dxy_move_pct?: number | null; usdinr_move_pct?: number | null;
  gap_surprise_pts?: number | null; events_overnight?: number | null; events_hold?: number | null; events_overnight_names?: string[]; events_hold_names?: string[];
}

/** Today's overnight context from the ledger, next to the range signals. */
export interface TodayContext {
  recorded: boolean;
  moves: Record<"gift" | "es" | "nq" | "brent" | "dxy" | "usdinr", number | null>;
  events_known: boolean;
  events_today: { time: string; country: string; name: string; forecast: string | null; actual: string | null }[];
  events_overnight: string[] | null;
}

/** `/api/intelligence/range-signals`: the signals now, for the newest session. */
export type RangeSignals =
  | { available: false; reason: string; context?: TodayContext | null }
  | ({ available: true; session: string; as_of: string; live: boolean; stale: boolean; spot: number; premium: number; prev_close: number | null; note: string; context?: TodayContext | null } & Signals);

export interface DayResult {
  day: string;
  dte: number;
  skipped: string | null;
  strike?: number;
  entry_premium?: number;
  entry_spot?: number;
  gross?: number;
  net?: number;
  max_adverse?: number;
  max_favourable?: number;
  restrikes?: number;
  exit_reason?: "time" | "stop" | "target";
  exit_at?: string;
  spot_move?: number;
  spot_source?: string;
  gated?: boolean;
  signals?: Signals;
}

export interface Bucket { days: number; mean?: number; median?: number; win_pct?: number; worst?: number }

export interface LabSummary {
  rule: string;
  days: number;
  skipped: number;
  sufficient: boolean;
  min_days: number;
  message: string;
  mean?: number;
  median?: number;
  win_pct?: number;
  worst?: number;
  best?: number;
  stdev?: number | null;
  mean_gross?: number;
  mean_max_adverse?: number;
  mean_restrikes?: number;
  mean_entry_premium?: number;
  total?: number;
  rupees_per_lot_total?: number;
  mean_range95?: [number, number] | null;
  median_range95?: [number, number] | null;
  leave_one_out?: { mean_min: number; mean_max: number; most_influential_day: string; swing: number };
  by_dte?: Record<"expiry day" | "1-2 days" | "3+ days", Bucket>;
  value?: string | number | null;
  /** gate sweeps: the days the gate skipped, and what they would have made if traded */
  gated_days?: number;
  avoided_mean?: number | null;
  avoided_worst?: number | null;
}

export interface SignalRow {
  signal: string;
  days: number;
  median_value?: number;
  pearson?: number | null;
  spearman?: number | null;
  at_or_below_median?: Bucket;
  above_median?: Bucket;
  split_gap?: number | null;
}

export interface LabStatus { days_total: number; days_loaded: number; loading: boolean; failed: Record<string, string>; first: string | null; last: string | null }

export interface EntryLab {
  status: LabStatus;
  rule: { label: string; entry: string; exit: string; stop_pct: number | null; target_pct: number | null; roll_pts: number | null; cost: number; roll_cost: number };
  summary: LabSummary;
  days: DayResult[];
  presets?: {
    entry_time: LabSummary[]; re_strike: LabSummary[]; stop: LabSummary[]; variants_tried: number; note: string;
    signal_study: { rule: string; days: number; signals: SignalRow[]; sufficient: boolean; note: string };
    gates: { gap: LabSummary[]; range_so_far: LabSummary[]; efficiency: LabSummary[]; opening_range_break: LabSummary[]; gift_move: LabSummary[]; events_hold: LabSummary[]; events_overnight: LabSummary[]; variants_tried: number };
  };
  assumptions: string[];
}

/** The query string of a rule (null = the rule does not use that part). */
export function entryLabQuery(p: EntryLabParams): string {
  const q = new URLSearchParams({ entry: p.entry, exit: p.exit, cost: String(p.cost), presets: "true" });
  if (p.stop != null) q.set("stop", String(p.stop));
  if (p.target != null) q.set("target", String(p.target));
  if (p.roll != null) q.set("roll", String(p.roll));
  if (p.maxGap != null) q.set("max_gap", String(p.maxGap));
  if (p.maxRange != null) q.set("max_range", String(p.maxRange));
  if (p.maxEff != null) q.set("max_eff", String(p.maxEff));
  if (p.skipBreak) q.set("skip_break", "true");
  if (p.maxGift != null) q.set("max_gift", String(p.maxGift));
  if (p.skipEventsHold) q.set("skip_events_hold", "true");
  if (p.skipEventsOvernight) q.set("skip_events_overnight", "true");
  return q.toString();
}
