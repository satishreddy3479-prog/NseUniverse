// Greeks and What-If engine: response types, API calls and small helpers. The numbers are computed by the backend (app/risk); the page only shows them.
// A missing number is null (never zero) and is drawn as an em dash.
import type { Leg } from "./strategy";
import { fmtTimeIST, MISSING } from "./format";

export type StickyRule = "moneyness" | "strike" | "delta";
export const STICKY_RULES: { id: StickyRule; label: string; hint: string }[] = [
  { id: "moneyness", label: "Moneyness (default)", hint: "The smile moves with the spot: each strike keeps its place relative to the forward." },
  { id: "strike", label: "Strike", hint: "Each strike keeps its own volatility whatever the spot does." },
  { id: "delta", label: "Delta", hint: "The smile holds as a function of delta; time passing moves strikes along it." },
];

/** What every response of /api/risk carries: the surface the numbers came from and when. */
export interface RiskStamp {
  surface_version_id: string;
  as_of_ist: string;
  source: "live" | "stored";
  stale: boolean;
  data: ExpiryData[];
}

export interface ExpiryData {
  expiry: string;
  status: string;
  snapshot_id: string | null;
  snapshot_at_ist: string | null;
  age_s: number | null;
  stale: boolean;
  quotes: number;
  live_books: number;
  lot_size: number | null;
  expiry_instant_ist: string | null;
}

export interface SviParams { a: number; b: number; rho: number; m: number; sigma: number }

export interface SurfaceSlice {
  expiry: string;
  t_years: number;
  forward: number | null;
  rate: number;
  forward_source: string;
  params: SviParams | null;
  n_quotes: number;
  n_used: number;
  n_rejected: number;
  n_flagged: number;
  rms_vol_pts: number | null;
  max_vol_pts: number | null;
  min_density: number | null;
  butterfly_ok: boolean;
  calendar_ok: boolean;
  calendar_max_violation: number;
  degraded: boolean;
  degraded_reason: string | null;
}

export interface SurfaceStrike {
  expiry: string;
  strike: number;
  cp: 1 | -1;
  price: number | null;
  source: "mid" | "ltp" | "none";
  iv: number | null;
  status: "used" | "unused" | "rejected" | "flagged";
  reason: string | null;
  fit_iv: number | null;
  residual_vol_pts: number | null;
  weight: number;
}

export interface RiskSurface extends RiskStamp {
  config: { spread_threshold_pct: number; allow_ltp_fallback: boolean; degraded_rms_vol_pts: number };
  slices: SurfaceSlice[];
  strikes: SurfaceStrike[];
}

export type Num = number | null;
export interface LegResult {
  expiry: string;
  strike: number;
  cp: 1 | -1;
  quantity: number;
  status: string;
  base_iv: Num;
  new_iv: Num;
  base_value: Num;
  new_value: Num;
  pnl: Num;
  pnl_vs_entry: Num;
}
export interface ScenarioParams { spot_shock: number; iv_shock: number; time_elapsed_hours: number; sticky_rule: StickyRule; rate_shock: number }
export interface ScenarioResult {
  scenario: ScenarioParams;
  surface_version_id: string;
  as_of_ist: string;
  pnl: Num;
  partial_pnl: Num;
  legs: LegResult[];
  forward_after: Record<string, Num>;
  t_years_after: Record<string, Num>;
  warnings: string[];
}
export interface RiskScenario extends RiskStamp { result: ScenarioResult }

export interface GridResult {
  surface_version_id: string;
  as_of_ist: string;
  row_axis: number[];
  col_axis: number[];
  col_kind: "iv_points" | "hours";
  pnl: Num[][];
  sticky_rule: StickyRule;
  warnings: string[];
}
export interface RiskGrid extends RiskStamp { grid: GridResult; forward: Num }

export interface PresetResult { scenario: ScenarioParams; pnl: Num; partial_pnl: Num; warnings: string[] }
export interface RiskPresets extends RiskStamp { presets: Record<string, PresetResult>; sticky_rules: StickyRule[] }

export type Greeks = Record<string, Num>;
export interface NetGreeks { raw: Greeks; rupee: Greeks }
export interface LegRisk {
  expiry: string;
  strike: number;
  cp: 1 | -1;
  quantity: number;
  lot_size: number;
  status: string;
  iv: Num;
  value: Num;
  forward: Num;
  t_years: Num;
  intrinsic: boolean;
  third_order_ok: boolean;
  third_order_noisy: boolean;
  rupee: Greeks;
}
export interface Breach { scope: "leg" | "bucket" | "portfolio"; scope_id: string; metric: string; value: number; limit: number; utilisation: number; level: "warn" | "breach"; partial: boolean }
export interface Bucket { expiry: string; label: "front" | "next" | "later"; hours_to_expiry: number; n_legs: number; net: NetGreeks }
export interface PortfolioRisk {
  surface_version_id: string;
  as_of_ist: string;
  complete: boolean;
  legs: LegRisk[];
  net: NetGreeks;
  partial_net: NetGreeks;
  buckets: Bucket[];
  beta: number;
  beta_source: string;
  beta_weighted_delta_units: Num;
  beta_weighted_delta_rupees: Num;
  delta_rupees_per_1pct: Num;
  breaches: Breach[];
  warnings: string[];
}
export interface RiskPortfolio extends RiskStamp { portfolio: PortfolioRisk }

export interface RiskStatus {
  enabled: boolean;
  config_error: string | null;
  surface_version_id: string | null;
  as_of_ist: string | null;
  rebuilds: number;
  default_sticky: StickyRule;
  max_legs: number;
}

/** A leg as the Strategy Builder holds it and as the API takes it. */
export interface RiskLeg { expiry: string; strike: number; type: "CE" | "PE"; action: "BUY" | "SELL"; lots: number; entry_price: number | null }

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RiskApiError(0, "network", "Backend unreachable.");
  }
  return parse<T>(res);
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    throw new RiskApiError(0, "network", "Backend unreachable.");
  }
  return parse<T>(res);
}

export class RiskApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { detail?: unknown };
      const d = b.detail;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        const o = d as { code?: string; message?: string };
        if (o.code) code = o.code;
        if (o.message) message = o.message;
      } else if (Array.isArray(d) && d.length > 0) {
        code = "invalid_input";
        message = String((d[0] as { msg?: string }).msg ?? message);
      }
    } catch { /* a non-JSON error body */ }
    throw new RiskApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const riskApi = {
  status: () => getJson<RiskStatus>("/api/risk/status"),
  surface: (expiries: string[] = []) => getJson<RiskSurface>(`/api/risk/surface${expiries.length ? "?" + expiries.map((e) => `expiry=${encodeURIComponent(e)}`).join("&") : ""}`),
  scenario: (legs: RiskLeg[], scenario: Partial<ScenarioParams>) => post<RiskScenario>("/api/risk/scenario", { legs, scenario }),
  grid: (legs: RiskLeg[], body: { kind: "spot_iv" | "spot_time" | "payoff"; sticky_rule?: StickyRule; fixed_hours?: number; fixed_iv_shock?: number; rate_shock?: number }) =>
    post<RiskGrid>("/api/risk/grid", { legs, ...body }),
  portfolio: (legs: RiskLeg[]) => post<RiskPortfolio>("/api/risk/portfolio", { legs }),
  presets: (legs: RiskLeg[]) => post<RiskPresets>("/api/risk/presets", { legs }),
};

/** "v12-ab34cd56ef78" -> "v12" (the sequence number the page shows; the full id is in the tooltip). */
export function versionLabel(id: string | null | undefined): string {
  return id ? id.split("-")[0]! : MISSING;
}

/** "Greeks as of 11:00:00 IST, surface v1": the stamp the page shows with every number. */
export function stampText(s: { as_of_ist: string; surface_version_id: string } | null | undefined): string {
  return s ? `Greeks as of ${fmtTimeIST(s.as_of_ist).replace(" IST", "")} IST, surface ${versionLabel(s.surface_version_id)}` : "No surface yet";
}

/** The enabled legs of the Strategy Builder as API legs (lots as whole numbers; the premium entered, or null). */
export function legsFromBuilder(legs: Leg[] | undefined | null): RiskLeg[] {
  return (legs ?? [])
    .filter((l): l is Leg & { type: "CE" | "PE" } => l.enabled !== false && l.type !== "FUT" && Number.isFinite(l.strike) && l.lots > 0)
    .map((l) => ({ expiry: l.expiry, strike: l.strike, type: l.type, action: l.action, lots: Math.round(l.lots), entry_price: l.premium ?? null }));
}

/** Rupees with a sign and the Indian grouping; null is a dash. Whole rupees above 100, two decimals below. */
export function rupees(v: Num | undefined, signed = true): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  const abs = Math.abs(v);
  const s = new Intl.NumberFormat("en-IN", { minimumFractionDigits: abs >= 100 ? 0 : 2, maximumFractionDigits: abs >= 100 ? 0 : 2 }).format(abs);
  return `${signed ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : ""}₹${s}`;
}

/** A plain number with a fixed number of decimals and a true minus sign; null is a dash. */
export function num(v: Num | undefined, d = 2, signed = false): string {
  if (v == null || !Number.isFinite(v)) return MISSING;
  const s = Math.abs(v).toFixed(d);
  return `${v < 0 ? "−" : signed && v > 0 ? "+" : ""}${s}`;
}

/** Volatility 0.1523 as "15.23%"; null is a dash. */
export function volPct(v: Num | undefined): string {
  return v == null || !Number.isFinite(v) ? MISSING : `${(v * 100).toFixed(2)}%`;
}

export const PRESET_LABELS: Record<string, string> = {
  gap_down: "Gap down 2%",
  iv_spike: "IV spike +5",
  expiry_crush: "Expiry-day crush",
  expiry_minus_3h: "3 h to expiry",
  expiry_minus_1h: "1 h to expiry",
  expiry_minus_15m: "15 min to expiry",
  sd_plus_1: "+1σ",
  sd_minus_1: "−1σ",
  sd_plus_2: "+2σ",
  sd_minus_2: "−2σ",
};
export const PRESET_ORDER = ["gap_down", "iv_spike", "expiry_crush", "expiry_minus_3h", "expiry_minus_1h", "expiry_minus_15m", "sd_minus_2", "sd_minus_1", "sd_plus_1", "sd_plus_2"];

export const legKey = (l: RiskLeg): string => `${l.expiry}|${l.strike}|${l.type}|${l.action}`;

// ---- the NIFTY future beside the options (the engine prices options only)
/**
 * Rupees per index point of the builder's open NIFTY futures: signed lots x multiplier x lot size. A future moves one for one with the index, so a scenario that
 * moves the index by ``ds`` points changes its value by ``units x ds``; the engine's convention is the same (the forward moves by the points, the basis stays).
 * Time and a rate move do not change a future's value in that convention. Exited and unticked legs are not counted.
 */
export function futureUnits(legs: readonly Leg[], lotSize: number | null | undefined): number {
  if (!lotSize) return 0;
  return legs.filter((l) => l.type === "FUT" && l.enabled !== false && l.exitPrice == null).reduce((a, l) => a + (l.action === "BUY" ? 1 : -1) * l.lots * lotSize, 0);
}
const plus = (v: Num, add: number): Num => (v == null ? null : v + add);
/** The grid with the futures added to every cell: rows are index shocks in points, so a row adds ``units x shock`` to each of its cells. */
export function gridWithFutures(g: GridResult, units: number): GridResult {
  return units === 0 ? g : { ...g, pnl: g.pnl.map((row, i) => row.map((v) => plus(v, units * (g.row_axis[i] ?? 0)))) };
}
export function scenarioWithFutures(r: ScenarioResult, units: number): ScenarioResult {
  const add = units * r.scenario.spot_shock;
  return units === 0 ? r : { ...r, pnl: plus(r.pnl, add), partial_pnl: plus(r.partial_pnl, add) };
}
export function presetsWithFutures(p: RiskPresets, units: number): RiskPresets {
  if (units === 0) return p;
  return { ...p, presets: Object.fromEntries(Object.entries(p.presets).map(([k, v]) => [k, { ...v, pnl: plus(v.pnl, units * v.scenario.spot_shock), partial_pnl: plus(v.partial_pnl, units * v.scenario.spot_shock) }])) };
}

