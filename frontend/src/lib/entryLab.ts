/** Types of the Entry Lab answer (`/api/intelligence/entry-lab`): short ATM straddle rules replayed on the recorded sessions. Past days, in-sample: a description, not a forecast. */

export interface EntryLabParams {
  entry: string;
  exit: string;
  stop: number | null;
  target: number | null;
  roll: number | null;
  cost: number;
}

export const DEFAULT_RULE: EntryLabParams = { entry: "09:45", exit: "15:15", stop: null, target: null, roll: null, cost: 2 };

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
}

export interface LabStatus { days_total: number; days_loaded: number; loading: boolean; failed: Record<string, string>; first: string | null; last: string | null }

export interface EntryLab {
  status: LabStatus;
  rule: { label: string; entry: string; exit: string; stop_pct: number | null; target_pct: number | null; roll_pts: number | null; cost: number; roll_cost: number };
  summary: LabSummary;
  days: DayResult[];
  presets?: { entry_time: LabSummary[]; re_strike: LabSummary[]; stop: LabSummary[]; variants_tried: number; note: string };
  assumptions: string[];
}

/** The query string of a rule (null = the rule does not use that part). */
export function entryLabQuery(p: EntryLabParams): string {
  const q = new URLSearchParams({ entry: p.entry, exit: p.exit, cost: String(p.cost), presets: "true" });
  if (p.stop != null) q.set("stop", String(p.stop));
  if (p.target != null) q.set("target", String(p.target));
  if (p.roll != null) q.set("roll", String(p.roll));
  return q.toString();
}
