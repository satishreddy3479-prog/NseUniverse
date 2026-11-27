/** The live position monitor's answer (GET /api/strategies/running/monitor). Points of premium for one lot of each leg; positive = the position gained. All figures are the server's. */

export interface MonitorLeg { label: string; entry: number; now: number; delta: number; iv_pct: number }
export interface MonitorDistance {
  spot: number; strike: number; points: number; restrike_points: number | null; share_of_restrike: number | null;
  expected_move: number; share_of_expected: number | null; minutes_left: number;
}
export interface MonitorAttribution { theta: number; vol: number; spot: number; other: number; total: number; ratio: number | null; steps: number }
export interface MonitorStatus { level: "ok" | "watch" | "alert"; text: string; reasons: string[] }
export interface MonitorSeries { t: string[]; theta: number[]; vol: number[]; spot: number[]; total: (number | null)[] }

export interface PositionMonitorData {
  available: boolean;
  reason?: string | null;
  as_of: string;
  limits: string;
  live?: boolean;
  name?: string | null;
  expiry?: string;
  lot_size?: number;
  mult?: number;
  since?: string | null;
  legs?: MonitorLeg[];
  pnl?: { points: number; rupees: number; booked_other_rupees: number };
  premium?: { entry: number; now: number; loss_pct: number | null; watch_pct: number; stop_pct: number; credit: boolean };
  delta?: { net: number; units: number };
  attribution?: MonitorAttribution;
  distance?: MonitorDistance | null;
  status?: MonitorStatus;
  series?: MonitorSeries;
  events?: { at: string; text: string }[];
}

/** Where a value sits on a track from lo to hi, as a percentage clamped to 0..100. */
export const place = (v: number, lo: number, hi: number): number => (hi === lo ? 50 : Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)));

/** Points of a polyline for a series, scaled into a box (null values break nothing: they are skipped). */
export function polyline(vals: (number | null)[], lo: number, hi: number, w: number, h: number): string {
  const n = vals.length;
  return vals
    .map((v, i) => (v == null ? null : `${n <= 1 ? 0 : Math.round((i / (n - 1)) * w * 10) / 10},${Math.round((h - ((v - lo) / (hi - lo || 1)) * h) * 10) / 10}`))
    .filter((p): p is string => p != null)
    .join(" ");
}
