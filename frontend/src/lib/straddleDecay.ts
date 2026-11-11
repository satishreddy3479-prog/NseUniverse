/** Types of /api/intelligence/straddle (straddle decay intelligence). A missing value is null and is shown as a dash, never as zero. */

export interface Stat { open: number | null; current: number | null; change: number | null; change_pct: number | null }
export interface Terms { theta: number; vega: number; delta: number; gamma: number; residual: number; actual: number }
export interface Efficiency {
  status: "efficient" | "slower" | "none" | "expansion" | "unavailable";
  efficiency_pct: number | null; actual_decay: number | null; expected_decay: number | null; shortfall?: number | null; reason: string | null;
}
export interface Window { ce: Terms; pe: Terms; both: Terms; steps: number; efficiency: Efficiency }
export type Windows = Record<"open" | "60" | "30", Window | null>;
export interface Realised { minutes: number | null; vol_pct: number | null; returns: number; gaps_skipped: number; note?: string }

export interface StraddleDecay {
  status: "ok" | "unavailable";
  message?: string;
  session?: string;
  expiry?: string;
  generated_at?: string;
  model?: string;
  rate_assumed?: number;
  proxies?: string;
  definitions?: Record<string, string>;
  samples?: number;
  unusable?: Record<string, number>;
  times?: string[];
  spot?: (number | null)[];
  tracker?: {
    fixed: { strike: number; ce: Stat; pe: Stat; straddle: Stat };
    rolling: { ce: Stat; pe: Stat; straddle: Stat; rolls: number; adjusted_change: number | null };
    opening_at: string;
  };
  series?: {
    rolling: Record<"ce" | "pe" | "straddle" | "ce_iv" | "pe_iv" | "iv", (number | null)[]> & { strike: (number | null)[] };
    fixed: Record<"ce" | "pe" | "straddle" | "ce_iv" | "pe_iv" | "iv", (number | null)[]> & { strike: (number | null)[] };
    skew25: (number | null)[]; skew10: (number | null)[]; rr25: (number | null)[]; rr10: (number | null)[];
  };
  iv?: {
    fixed: { ce: Stat; pe: Stat; combined: Stat };
    rolling: { ce: Stat; pe: Stat; combined: Stat };
    skew25: Stat; skew10: Stat; rr25: Stat; rr10: Stat;
    per_spot_pct: number | null;
    iv_vs_spot: { slope_pts_per_pct: number | null; corr: number | null; pairs: number; note: string };
    support: { side: string; text: string };
  };
  attribution?: { fixed: Windows; rolling: Windows };
  cumulative?: Record<"fixed" | "rolling", Record<keyof Terms, (number | null)[]>>;
  realised_vs_implied?: {
    windows: Record<string, Realised>; iv_now: number | null; iv_open: number | null; gap: Record<string, number | null>;
    implied_move_pts: number | null; implied_move_pct: number | null; implied_daily_sd_pts: number | null;
    actual_move_pts: number | null; actual_range_pts: number | null; move_vs_daily_sd: number | null;
    realised_variance: { sum_sq_returns: number | null; session_move_sd_pct: number | null; returns: number };
    note: string;
  };
  structure?: {
    gex: { at: string | null; net: number | null; regime: string; flip: number | null; flip_distance_pts: number | null; flip_distance_pct: number | null; net_change_15m: number | null; relationship: string; spot_change_15m_pct: number | null } | null;
    concentration: { share_pct: number | null; atm: number; contracts_missing: number; scope: string } | null;
    straddle_theta_per_day: number | null; straddle_gamma: number | null; breakeven_daily_move_pts: number | null; realised_daily_sd_pts: number | null; realised_vs_breakeven: number | null;
    spot_move_pts: number | null; note: string;
  };
  quality?: {
    last_sample_at: string; age_minutes: number | null; stale: boolean; live: boolean; steps_skipped_fixed: number; steps_skipped_rolling: number;
    forward_fallbacks: number; estimated: string[]; stride_note: string;
  };
  interpretation: { q: string; a: string }[];
  climate?: { label: "favourable" | "mixed" | "unfavourable" | "unknown"; tally: number; because: string[]; window: string; note: string };
}

export interface StraddleValidation {
  generated_at: string; window_minutes: number; sufficient: boolean; message: string; method: string; note: string;
  sessions: { session: string; expiry: string; windows: number; predicted: number | null; actual: number | null; ratio: number | null }[];
  overall: ValAgg; earlier_half: ValAgg; later_half: ValAgg;
}
export interface ValAgg { windows: number; predicted_mean?: number | null; actual_mean?: number | null; ratio_actual_to_predicted?: number | null; mae?: number | null; corr?: number | null; decayed_share_pct?: number | null }
