// NIFTY 50 Market Intelligence page: renders what the aggregation service returned, and says plainly what is missing. Numbers are fixtures.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketIntelligence } from "../pages/MarketIntelligence";
import { Home } from "../pages/Home";
import type { EngineView, HeavyStock, Heavyweights, Intelligence, MlDigest, Timeline, VolDetail } from "../lib/intelligence";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

const eng = (key: string, name: string, score: number | null, o: Partial<EngineView> = {}): EngineView => ({
  key, name, score, class: score == null ? "Unavailable" : score >= 35 ? "Bullish" : "Mild Bullish", tilt: score == null ? "unavailable" : score >= 15 ? "bullish" : score <= -15 ? "bearish" : "neutral", link: "/tools/x", weight: 20, contribution: score == null ? null : score / 5, status: score == null ? "UNAVAILABLE" : key === "positioning" ? "PARTIAL" : "AVAILABLE", effective_weight: 15,
  terms: score == null ? [{ name: "ATM IV change against price (15 min)", score: null, detail: "no snapshot 15 minutes earlier", available: false, proxy: false }] : [{ name: "Futures CVD (Proxy), session", score: 40, detail: "session CVD +25.0% of classified volume", available: true, proxy: true, family: "futures_cvd", weight: 1, shares: [] }, { name: "Spot versus the gamma flip (modelled)", score: 20, detail: "spot +0.41% from the modelled flip", available: true, proxy: false, family: "gex", weight: 0.5, shares: ["price"], overlap_adjustment: "weight 0.5: shares price with another group" }],
  supporting: [], conflicting: score != null ? ["Price versus VWAP: future below its VWAP"] : [], unavailable: [], freshness: { fresh: score == null ? null : true, age_s: 12, inputs: [], failed: [] }, ...o,
});
const win = (m: number, p: number | null, n: number | null, status = "ok") => ({ minutes: m, cvd: p == null ? null : p * 100, pct: p, norm: n, price_change_pct: 0.1, status });
const hstock = (symbol: string, name: string, weight: number, prev: number, sess: number, n15: number | null, bias: string, o: Partial<HeavyStock> = {}): HeavyStock => ({
  symbol, name, weight, previous_weight: prev, price: 1500, change_pct: 0.4, vwap: 1495, price_vs_vwap_pct: 0.33, session: { cvd: sess * 100, pct: sess, norm: sess * 3, buy_volume: 6000, sell_volume: 4000 },
  windows: { "5": win(5, 20, 66.4), "15": n15 == null ? win(15, null, null, "unavailable: fewer than 15 minutes of continuous stored flow") : win(15, 20, n15), "30": win(30, null, null, "unavailable: fewer than 30 minutes of continuous stored flow") },
  momentum: 8.5, acceleration: -2.0, basis_norm: n15, bias, price_cvd_divergence: null, contribution_pct: 30, methodology: "CVD PROXY", valid: true,
  freshness: { updated: "2026-11-09T04:29:58Z", age_s: 3, feed: "live", fresh: true, classified_share: 0.95, coverage_of_day_volume: 0.9, quote_rule_share: 0.7, stored_samples: 40 }, ...o,
});
const hw: Heavyweights = {
  available: true, method: "CVD PROXY: quote rule, then tick rule; estimated from the quote stream, no aggressor-side trade tape", limits: ["Buyer- and seller-initiated volume are not observed: every CVD figure is an estimate (CVD PROXY).", "Trade timestamps are not available from the feed."],
  as_of: "2026-11-09T04:29:58Z",
  stocks: [hstock("HDFCBANK", "HDFC Bank Ltd.", 13.1, 12.4, 20, 66.4, "Buying · above VWAP (confirmed)"), hstock("RELIANCE", "Reliance Industries Ltd.", 8.9, 9.0, 15, 50, "Buying · above VWAP (confirmed)"),
    hstock("ICICIBANK", "ICICI Bank Ltd.", 8.5, 8.4, -10, -30, "Selling · below VWAP (confirmed)", { contribution_pct: -12 }), hstock("INFY", "Infosys Ltd.", 5.0, 5.1, 12, 40, "Buying · above VWAP (confirmed)"),
    hstock("TCS", "Tata Consultancy Services Ltd.", 4.0, 4.0, 0, null, "No reading", { valid: false, session: { cvd: null, pct: null, norm: null, buy_volume: null, sell_volume: null }, contribution_pct: null, freshness: { updated: "2026-11-09T04:20:00Z", age_s: 600, feed: "STALE", fresh: false, classified_share: null, coverage_of_day_volume: null, quote_rule_share: null, stored_samples: 30 } })],
  aggregate: { session: { score: 38, valid: 4, of: 5, weight_share: 0.89, status: "PARTIAL: 4 of 5 stocks" }, "5": { score: 52, valid: 4, of: 5, weight_share: 0.89, status: "PARTIAL: 4 of 5 stocks" }, "15": { score: 41, valid: 4, of: 5, weight_share: 0.89, status: "PARTIAL: 4 of 5 stocks" },
    "30": { score: null, valid: 0, of: 5, weight_share: 0, status: "unavailable: 0 of 5 stocks valid (need 3 and 60% of the weight)" }, momentum: 11, acceleration: 4 },
  participation: { class: "Broad heavyweight buying", valid: 4, positive: 3, negative: 1, neutral: 0, weight_share_positive: 0.76, weight_share_negative: 0.24, top_contributor: { symbol: "HDFCBANK", share: 0.45 }, reason: null },
  nifty: { change_15m_pct: 0.12, day_change_pct: 0.3, futures_vwap_side: "above", futures_vwap_pts: 38.5, vwap_note: "the NIFTY future against its own VWAP; the index itself has no VWAP (no traded volume)" }, relative_strength_pct: 0.15,
  series: [{ t: "2026-11-09T04:10:00Z", session: 30, w5: 40, w15: null, spot: 24050 }, { t: "2026-11-09T04:20:00Z", session: 35, w5: 45, w15: 38, spot: 24080 }, { t: "2026-11-09T04:30:00Z", session: 38, w5: 52, w15: 41, spot: 24100 }],
  quality: { valid: 4, of: 5, weight_share: 0.89, aggregate_available: true, valid_constituents: 4, weights: { as_of: "2026-06-30", effective_date: "2026-06-30", verified_at: "2026-11-09T13:00:00Z", verified_note: "x", live: false, source: "NSE index tracker", age_days: 132, stale: true, approximate: false, basis: "official index weights" } },
};
const ml: MlDigest = {
  status: { status: "collecting", stage_name: "Collecting labelled data", labelled_sessions: 3, complete_sessions: 4, sessions_with_samples: 5, next: { name: "Experimental training", at_sessions: 5, sessions_to_go: 2 },
    stages: [{ id: "collecting", name: "Collecting labelled data", from_sessions: 0, what: "x" }, { id: "experimental", name: "Experimental training", from_sessions: 5, what: "y" }, { id: "validated", name: "Eligible for 'validated'", from_sessions: 60, what: "z" }] },
  computing: false, next_run: "once a session day after 15:45 IST",
  last_evaluation: { computed_at: "2026-11-10T10:40:00Z", horizon_minutes: 15, barrier_k: 0.5, status: "experimental", sessions: 8, test_sessions: 5, rows: 900, reason: null,
    models: { majority: { log_loss: 1.0912, brier: 0.6, n: 400, ece: 0.02 }, momentum: { log_loss: 1.0987, brier: 0.61, n: 400, ece: 0.03 }, logistic: { log_loss: 1.1034, brier: 0.62, n: 400, ece: 0.06 } },
    best_baseline_log_loss: 1.0912, model_log_loss_gain: -0.0122, feature_groups: { options: { log_loss: 1.1, delta_vs_price_only: -0.0021 }, breadth: { log_loss: 1.12, delta_vs_price_only: 0.0105 } },
    gate: { status: "experimental", show_probabilities: false, beat_share: 0.2, mean_log_loss_gain: -0.0122, sign_test_p: 0.81, ece: 0.06, reasons: ["only 8 labelled sessions (validation needs 60)", "calibration error 0.060 exceeds 0.05"] } },
};
const base: Intelligence = {
  generated_at: "2026-11-09T04:30:00Z", expiry: "2026-11-10", session: "2026-11-09", enabled: true,
  status: { market: { ok: true, age_s: 2, ms: 3 }, gex: { ok: false, age_s: null, ms: 1, error: "RuntimeError: module down" }, intraday: { ok: true, age_s: 20, ms: 40 } },
  sentiment: { score: 42, class: "Bullish", coverage: 0.85, engines_available: 4, engine_counts: { available: 3, partial: 1, unavailable: 1 }, weights_note: "Provisional weights – not yet statistically calibrated.", agreement: 0.8, freshness: 1, confidence: 68, confidence_parts: { coverage_factor: 1, agreement: 0.8, freshness: 0.85 }, reason: null, trend_strength: 41, signal_quality: "High", data_completeness: 0.85, volatility_regime: "Contraction (Normal realised)" },
  regime: { name: "Bullish trend", evidence: ["score +42 with 80% agreement"], volatility: "Contraction", gamma: "positive", previous: "Sideways / Range", changed_at: "2026-11-09T04:10:00Z" },
  engines: [eng("positioning", "A. Derivatives positioning", 55), eng("orderflow", "B. Order-flow proxies", 30), eng("volatility", "C. Volatility", null), eng("structure", "D. Market structure", 25), eng("participation", "E. Participation and breadth", 40)],
  pulse: { spot: 24100, change_pct: 0.3, futures: 24148, basis: 48, basis_pct: 0.2, atm_strike: 24100, expiry: "2026-11-10", atm_ce_premium: 95.5, atm_pe_premium: 88.0, atm_iv: 15.2, india_vix: { value: 14.1, as_of: "2026-11-06", label: "India VIX – Last Daily Close", intraday_signal: false, note: "A daily close dated 2026-11-06, not a live quote." }, pcr: 1.12, net_gex: 42.5, gamma_flip: 24000, futures_oi_change: 52000, futures_cvd_pct: 25, futures_vwap: 24050, heavyweight_cvd: 31 },
  gex: { available: true, net: 42.5, flip: 24000, flip_distance_pct: 0.41, regime: "positive", call_wall: 24200, put_wall: 23800, peak: 24000, near_net: 5, relationship: "stabilising", net_change_pct: 12, net_change_15m: 4.5, ce: 60, pe: -17.5, universe: "dynamic", session: "2026-11-09" },
  interpretation: "Market sentiment is bullish (score +42, confidence 68); regime: bullish trend. Futures positioning and order flow lean bullish (+55).",
  divergences: [{ id: "price_cvd", name: "Price versus futures CVD", direction: "bearish", severity: "medium", reading: "NIFTY +0.30% (15 min) while estimated CVD -20%", explanation: "Price and estimated net aggressor volume point opposite ways.", invalidation: "CVD turns to the same sign as price", status: "developing", since: "2026-11-09T04:20:00Z", previous: "NIFTY +0.20% while CVD -10%" }],
  divergences_invalidated: [{ id: "vol_no_price", status: "invalidated" }], divergences_unavailable: ["OI migration versus price: no stored OI-migration series exists on the server yet"],
  scenarios: { available: true, label: "Heuristic scores (sum 100), not probabilities: no calibrated model exists for them",
    bullish: { score: 55, supporting: ["Futures positioning and order flow: long buildup"], resistance: 24200, confirmation: "sustained trade above 24200", invalidation: "a hold below 24050 (VWAP)" },
    bearish: { score: 15, support: 23800, confirmation: "sustained trade below 23800", invalidation: "a hold above 24050" }, sideways: { score: 30, range: [23800, 24200], gamma: "positive", volatility: "Contraction", invalidation: "a close outside 23800 to 24200" },
    horizons: [{ horizon: "Next 15 minutes", minutes: 15, one_sd_points: 45 }, { horizon: "Next 30 minutes", minutes: 30, one_sd_points: 64 }, { horizon: "Next 60 minutes", minutes: 60, one_sd_points: 91 }, { horizon: "End of session", minutes: 315, one_sd_points: 208 }, { horizon: "Next trading session", minutes: 375, one_sd_points: 227 }] },
  panels: {
    options: { ce_oi: 100000, pe_oi: 112000, ce_oi_change: 5000, pe_oi_change: 12000, pcr_oi: 1.12, pcr_vol: 1.0, pcr_first: 1.02, max_ce_oi_strike: 24300, max_pe_oi_strike: 23900, largest_call_additions: [{ strike: 24300, change: 4000 }], largest_put_additions: [{ strike: 23900, change: 9000 }], largest_call_unwinding: [], largest_put_unwinding: [], demand: [{ side: "PE", group: "otm", label: "Put writing", summary: { oi_pct: 4.1, premium_pct: -3, iv_change: -0.2, volume_change: 100, strikes: 5 } }], note: "OI does not identify who bought or sold; labels are 'potential'." },
    gex: { available: true, net: 42.5, flip: 24000, flip_distance_pct: 0.41, regime: "positive", call_wall: 24200, put_wall: 23800, near_net: 5, ce: 60, pe: -17.5, peak: 24000, relationship: "stabilising", net_change_15m: 4.5, net_change_pct: 12, universe: "dynamic", session: "2026-11-09", label: "Modelled GEX exposure (not observed dealer positioning)", methodology: "GEX = gamma × OI × spot² × 0.01 / 10⁷, calls +, puts −: a model assumption, not observed dealer positioning." },
    vega: { ce_avg_vega: 5.2, pe_avg_vega: 5.0, strikes: 11, note: "Average vega per option." },
    volatility: { atm_iv: 15.2, iv_change_15m: -0.4, hv: 11, rv: 10, india_vix: 14.1, india_vix_label: "India VIX – Last Daily Close", india_vix_as_of: "2026-11-06", ivr_252: 42, ivp_252: 55, skew_25d: 2.1, skew_10d: 4.0, risk_reversal_25d: -2.1, butterfly_25d: 0.4, term_slope_30d: 1.2, term_shape: "contango", term: [{ expiry: "2026-11-10", days: 1, atm_iv: 15.2 }], expected_move_1sd_pts: 160, straddle: 183, interpretation: null, note: "India VIX is a daily close." },
    futures: { series: { future: 24148, basis: 48 }, contract: "NIFTY26NOVFUT", oi_change: 52000, volume: 900000, buildup: "long buildup", flow: { cvd_pct: 25, classified_share: 0.9, depth_imbalance: 0.1 }, vwap: { vwap: 24050, distance_pct: 0.2, slope_pts_per_15m: 4 }, rolling: { estimated: true, acceleration: { minutes: 5, current_cvd: 1000, previous_cvd: 600, current_rate: 200, previous_rate: 120, rate_change: 80, acceleration: 16, current_pct: 20, previous_pct: 12, status: "ok" }, ok_windows: 2, windows: { "5": { minutes: 5, cvd: 1000, cvd_pct: 20, volume: 5000, classified: 5000, from: "t0", to: "t1", status: "ok" }, "15": { minutes: 15, cvd: 2400, cvd_pct: 16, volume: 15000, classified: 15000, from: "t0", to: "t1", status: "ok" }, "30": { minutes: 30, cvd: null, cvd_pct: null, volume: null, classified: null, from: null, to: "t1", status: "unavailable: fewer than 30 minutes of flow samples stored today" } } }, unavailable: ["rollover data (needs near-month and next-month contract OI and volume history)"], note: "CVD is an estimate by the quote and tick rule." },
  },
  heavyweights: hw, intraday_ml: ml,
  alerts: [{ id: 1, at: "2026-11-09T04:15:00Z", kind: "VWAP reclaim", severity: "medium", direction: "bullish", text: "Future reclaimed its day VWAP", evidence: [], confirmation: "holds for 5 minutes", invalidation: "price crosses back" }],
  config: { weights: { positioning: 30, orderflow: 20, volatility: 10, structure: 20, participation: 20 }, min_coverage: 0.55, min_engines: 3, note: "Provisional weights – not yet statistically calibrated." }, compute_ms: 38,
  capabilities: [
    { id: "session_cvd", name: "Session CVD (futures)", status: "AVAILABLE", reason: "ESTIMATE by the quote and tick rule, not a trade tape", source: "market", as_of: "2026-11-09T04:29:58+00:00", link: "/tools/future-flow" },
    { id: "vega", name: "Vega", status: "PARTIAL", reason: "average vega per option only", source: "intraday", as_of: null, link: "/tools/vega-analysis" },
    { id: "rollover", name: "Rollover data", status: "UNAVAILABLE", reason: "Rollover needs a stored series for both contracts; no percentage is shown.", source: "futures", as_of: null, link: null },
    { id: "stock_futures", name: "Individual stock futures", status: "UNAVAILABLE", reason: "stock futures are not subscribed or stored", source: "market", as_of: null, link: null },
  ],
  overlap_audit: { findings: [{ input: "Aggregate command-centre score", was: "a term inside the structure engine", fix: "removed: it is itself built from price, VWAP, breadth, PCR and OI" }], terms: [] },
};
const timeline: Timeline = { session: "2026-11-09", sessions: ["2026-11-09"], recorded: 2, note: "Only minutes that were recorded appear here; a minute without a row was not captured and is not reconstructed.", points: [
  { session: "2026-11-09", at: "2026-11-09T04:10:00Z", spot: 24050, score: 30, confidence: 60, coverage: 0.85, regime: "Sideways / Range", vol_regime: "Normal", gamma_regime: "positive", engines: { futures: 40, options: 20, gex: null }, metrics: { cvd_pct: 12, net_gex: 40, atm_iv: 15.5, heavy_cvd: 10, fut_oi_change: 30000 }, divs: [] },
  { session: "2026-11-09", at: "2026-11-09T04:30:00Z", spot: 24100, score: 42, confidence: 68, coverage: 0.85, regime: "Bullish trend", vol_regime: "Contraction", gamma_regime: "positive", engines: { futures: 55, options: 30, gex: null }, metrics: { cvd_pct: 25, net_gex: 42.5, atm_iv: 15.2, heavy_cvd: 31, fut_oi_change: 52000 }, divs: [{ id: "price_cvd" }] }] };

function view(summary: unknown, tl: unknown = timeline, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/timeline") ? tl : summary), { status })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MarketIntelligence /></MemoryRouter></QueryClientProvider>);
}

describe("Market Intelligence page", () => {
  it("shows direction, score, confidence with its parts, regime and volatility regime in the first block", async () => {
    view(base);
    const strip = await screen.findByTestId("mi-command");
    expect(within(strip).getByTestId("mi-class").textContent).toBe("Bullish");
    expect(strip.textContent).toContain("Directional score +42 / 100");
    expect(strip.textContent).toContain("68 / 100");
    expect(strip.textContent).toContain("EVIDENCE QUALITY");
    expect(strip.textContent).not.toMatch(/Confidence/i);
    expect(strip.textContent).toContain("coverage 100% · agreement 80% · freshness 85%");
    expect(strip.textContent).toContain("Bullish trend");
    expect(strip.textContent).toContain("was Sideways / Range");
    expect(strip.textContent).toContain("Contraction (Normal realised)");
    expect(strip.textContent).toContain("Signal quality");
    // five separate quantities: score, confidence, data coverage (with the three counts), evidence agreement, data freshness
    expect(strip.textContent).toContain("3 available · 1 partial · 1 unavailable");
    expect(strip.textContent).toContain("Evidence agreement");
    expect(strip.textContent).toContain("Data freshness");
    expect(within(strip).getByTestId("mi-provisional").textContent).toContain("Provisional weights – not yet statistically calibrated.");
    expect(within(strip).getByTestId("mi-provisional").textContent).toContain("not a probability that the direction is right");
    expect(within(strip).getByTestId("mi-provisional").textContent).toContain("not a prediction");
  });
  it("says when conflicting groups have capped the confidence", async () => {
    view({ ...base, sentiment: { ...base.sentiment, confidence: 40, agreement: 0.4, confidence_parts: { coverage_factor: 1, agreement: 0.4, freshness: 1, conflict_cap_applied: true } } });
    expect((await screen.findByTestId("mi-command")).textContent).toContain("capped: groups conflict");
  });
  it("reports a failed input and an engine with no data instead of scoring it neutral", async () => {
    view(base);
    expect((await screen.findByTestId("mi-quality")).textContent).toContain("Inputs not available: gex");
    const vol = screen.getByTestId("mi-engine-volatility");
    expect(vol.textContent).toContain("Unavailable");
    expect(vol.textContent).toContain("no data");
    expect(screen.getByTestId("mi-status-volatility").textContent).toBe("UNAVAILABLE");
    expect(screen.getByTestId("mi-status-positioning").textContent).toBe("PARTIAL");
    expect(screen.getByTestId("mi-status-orderflow").textContent).toBe("AVAILABLE");
    const flow = screen.getByTestId("mi-engine-orderflow");
    expect(flow.textContent).toContain("proxy"); // estimated CVD is labelled a proxy
    expect(flow.textContent).toContain("Futures CVD (Proxy), session");
    expect(flow.textContent).toContain("Conflicting: Price versus VWAP");
    expect(flow.textContent).toContain("overlap adjustment: weight 0.5: shares price with another group");
  });
  it("shows INSUFFICIENT DATA instead of a score when coverage is too low, and no scenarios", async () => {
    view({ ...base, sentiment: { ...base.sentiment, score: null, class: "INSUFFICIENT DATA – SENTIMENT UNRELIABLE", confidence: null, reason: "2 engines available (need 3) with coverage 45% (need 55%)", agreement: null }, scenarios: { available: false, label: "x", reason: "no data" } });
    expect((await screen.findByTestId("mi-class")).textContent).toBe("INSUFFICIENT DATA – SENTIMENT UNRELIABLE");
    expect(screen.getByTestId("mi-score").textContent).toContain("2 engines available (need 3)");
    expect(screen.getByTestId("mi-scenarios").textContent).toContain("Scenarios need a fused sentiment");
  });
  it("lists the pulse values from the service, including the VIX close label", async () => {
    view(base);
    const pulses = (await screen.findAllByTestId("mi-pulse")).map((p) => p.textContent).join("|");
    expect(pulses).toContain("India VIX – Last Daily Close14.10");
    expect(pulses).toContain("observed 2026-11-06 (not live)");
    expect(pulses).toContain("Futures CVD (Proxy)+25.0%");
    expect(pulses).toContain("Heavyweight CVD (Proxy)");
    expect(pulses).toContain("estimate (proxy)");
    expect(pulses).toContain("Gamma flip (modelled)24,000");
    expect(pulses).toContain("Net GEX (modelled)");
    const tips = (await screen.findAllByTestId("mi-pulse")).map((p) => p.getAttribute("title") ?? "").join("|");
    expect(tips).toContain("not genuine aggressor-side CVD"); // the CVD tooltip says what it is not
    expect(tips).toContain("buyer and seller volume are not observed");
    expect(tips).toContain("not used as an intraday volatility signal");
    expect(tips).toContain("Dealer positioning is not observed");
  });
  it("generates the interpretation from the readings and states what would weaken the view", async () => {
    view(base);
    expect((await screen.findByTestId("mi-interpretation")).textContent).toContain("Market sentiment is bullish (score +42");
    expect(screen.getByTestId("mi-invalidation").textContent).toContain("a hold below 24050 (VWAP)");
  });
  it("shows divergences with status, previous reading and invalidation, and the checks that cannot be made", async () => {
    view(base);
    const d = await screen.findByTestId("mi-div");
    expect(d.textContent).toContain("Price versus futures CVD");
    expect(d.textContent).toContain("developing since");
    expect(d.textContent).toContain("Earlier: NIFTY +0.20% while CVD -10%");
    expect(d.textContent).toContain("Invalidated if: CVD turns to the same sign as price");
    expect(screen.getByTestId("mi-divergences").textContent).toContain("never a reversal signal");
    expect(screen.getByTestId("mi-divergences").textContent).toContain("OI migration versus price");
  });
  it("labels the scenarios as heuristic scores and shows the horizon ranges as estimates", async () => {
    view(base);
    const sc = await screen.findByTestId("mi-scenarios");
    expect(sc.textContent).toContain("not probabilities");
    expect(within(sc).getByTestId("mi-scenario-bullish").textContent).toContain("55");
    expect(within(sc).getByTestId("mi-scenario-sideways").textContent).toContain("23,800 to 24,200");
    expect(within(sc).getByTestId("mi-horizons").textContent).toContain("±45");
    expect(sc.textContent).toContain("no predictive accuracy is claimed");
  });
  it("the timeline shows only recorded minutes and lets you inspect one", async () => {
    view(base);
    expect((await screen.findByTestId("mi-minute")).textContent).toContain("Bullish trend");
    fireEvent.change(screen.getByLabelText("Inspect minute"), { target: { value: "0" } });
    expect(screen.getByTestId("mi-minute").textContent).toContain("Sideways / Range");
    expect(screen.getByTestId("mi-minute").textContent).toContain("24,050");
    expect(screen.getByTestId("mi-timeline").textContent).toContain("not reconstructed");
  });
  it("an empty timeline says nothing was recorded rather than inventing history", async () => {
    view(base, { ...timeline, points: [], recorded: 0 });
    expect((await screen.findByTestId("mi-timeline-empty")).textContent).toContain("not reconstructed");
  });
  it("shows the alerts with evidence, confirmation and invalidation", async () => {
    view(base);
    const a = await screen.findByTestId("mi-alert");
    expect(a.textContent).toContain("VWAP reclaim");
    expect(a.textContent).toContain("Confirmed by: holds for 5 minutes. Invalidated if: price crosses back.");
  });
  it("the detail panels link to the existing analysis pages and keep their notes", async () => {
    view(base);
    const d = await screen.findByTestId("mi-details");
    expect(within(d).getAllByRole("link", { name: /Open the full analysis/ }).map((l) => l.getAttribute("href"))).toEqual(["/tools/strike-positioning", "/tools/gamma-exposure", "/tools/volatility-skew", "/tools/future-flow"]);
    expect(d.textContent).toContain("not observed dealer positioning");
    expect(d.textContent).toContain("OI does not identify who bought or sold");
    expect(d.textContent).toContain("rollover data");
    expect(d.textContent).toContain("Modelled GEX exposure (not observed dealer positioning)");
    expect(d.textContent).toContain("India VIX – Last Daily Close");
    expect(d.textContent).toContain("14.10 (2026-11-06)");
  });
  it("shows the rolling CVD windows and says why a window cannot be formed", async () => {
    view(base);
    const r = await screen.findByTestId("mi-rolling");
    expect(r.textContent).toContain("Rolling futures CVD (Proxy)");
    expect(r.textContent).toContain("last 5 min");
    expect(r.textContent).toContain("+20.0%");
    expect(r.textContent).toContain("unavailable: fewer than 30 minutes of flow samples stored today");
    const a = await screen.findByTestId("mi-accel");
    expect(a.textContent).toContain("two consecutive, non-overlapping 5-minute windows of equal length");
    expect(a.textContent).toContain("Current 5 min");
    expect(a.textContent).toContain("Previous 5 min");
    expect(a.textContent).toContain("+80.0"); // change in rate
    expect(a.textContent).toContain("+16.00"); // acceleration
    expect(a.textContent).toContain("never subtracted");
  });
  it("lists AVAILABLE, PARTIAL and UNAVAILABLE capabilities with source timestamps and links", async () => {
    view(base);
    const c = await screen.findByTestId("mi-capabilities");
    expect(within(c).getByTestId("mi-cap-session_cvd").textContent).toContain("AVAILABLE");
    expect(within(c).getByTestId("mi-cap-session_cvd").textContent).toContain("09:59:58 IST"); // 04:29:58 UTC, shown in IST
    expect(within(c).getByTestId("mi-cap-vega").textContent).toContain("PARTIAL");
    expect(within(c).getByTestId("mi-cap-rollover").textContent).toContain("UNAVAILABLE");
    expect(within(c).getByTestId("mi-cap-rollover").textContent).toContain("no percentage is shown");
    expect(within(c).getByTestId("mi-cap-stock_futures").textContent).toContain("not subscribed or stored");
    expect(within(c).getByRole("link", { name: "Session CVD (futures)" }).getAttribute("href")).toBe("/tools/future-flow");
  });
  it("documents the evidence-overlap corrections", async () => {
    view(base);
    expect((await screen.findByTestId("mi-overlap")).textContent).toContain("Aggregate command-centre score");
  });
  it("marks a group stale when its feed has stopped, without hiding the dashboard", async () => {
    view({ ...base, engines: base.engines.map((e) => (e.key === "orderflow" ? { ...e, freshness: { ...e.freshness, fresh: false, age_s: 600 } } : e)) });
    expect((await screen.findByTestId("mi-engine-orderflow")).textContent).toContain("STALE · 10 min old");
    expect((await screen.findByTestId("mi-quality")).textContent).toContain("Stale, not shown as live: B. Order-flow proxies");
  });
  it("documents the method and each input's freshness", async () => {
    view(base);
    expect((await screen.findByTestId("mi-method")).textContent).toContain("Σ(group score × effective weight)");
    expect(screen.getByTestId("mi-method").textContent).toContain("never a probability");
    expect(screen.getByTestId("mi-method").textContent).toContain("India VIX is a daily close and is never an intraday signal");
    expect(screen.getByTestId("mi-sources").textContent).toContain("RuntimeError: module down");
    expect(screen.getByTestId("mi-sources").textContent).toContain("Source timestamp");
  });
  it("shows an error state without breaking when the service is down", async () => {
    view({ detail: { code: "disabled", message: "the market-intelligence dashboard is turned off" } }, timeline, 404);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});

describe("Corrections: weights, VWAP instrument, gamma flip, observations", () => {
  it("shows the weight effective date, source, load time and valid constituents and never calls them live", async () => {
    view(base);
    const q = (await screen.findByTestId("hw-quality")).textContent ?? "";
    expect(q).toContain("Index weights (not live)");
    expect(q).toContain("effective 2026-06-30");
    expect(q).toContain("source NSE index tracker");
    expect(q).toContain("not a re-check against NSE");
    expect(q).toContain("Valid constituents: 4");
    expect(q).not.toMatch(/live weights/i);
  });
  it("labels the VWAP tile as the future against its own VWAP, not spot", async () => {
    view(base);
    const nifty = await screen.findByTestId("hw-nifty");
    expect(nifty.textContent).toContain("Futures vs futures VWAP");
    expect(nifty.textContent).toContain("not spot");
    expect(nifty.textContent).not.toContain("NIFTY vs VWAP");
  });
  it("shows the gamma flip in points and percent with its support and the range it moves in", async () => {
    const d = { ...base, panels: { ...base.panels, gex: { ...base.panels.gex, flip_distance_pts: 100, flip_range: [23900, 24100] as [number, number], flip_support: { status: "unstable" as const, reasons: ["moves 200 points (0.83 % of spot) with the strike set or a 10 % OI disagreement"] } } } };
    view(d);
    const g = await screen.findByTestId("mi-detail-gex");
    expect(g.textContent).toContain("+100 pts (+0.41%)");
    expect(g.textContent).toContain("UNSTABLE");
    expect(g.textContent).toContain("23,900 to 24,100");
    expect((await screen.findByTestId("mi-flip-reasons")).textContent).toContain("shown as calculated, not corrected");
  });
  it("lists the side-by-side readings and says none is a reversal signal", async () => {
    view({ ...base, observations: [{ id: "up_oi_down", title: "Futures open interest falling while price rises", reading: "NIFTY future +0.30% while futures OI changed -20,000 over 15 minutes", explanation: "Short covering can lift price. This is a description of conflicting or confirming readings, not a reversal signal.", reversal_signal: false }] });
    const o = await screen.findByTestId("mi-observations");
    expect(o.textContent).toContain("never read as a reversal");
    expect(within(o).getByTestId("mi-observation").textContent).toContain("not a reversal signal");
  });
});

const vb = (ce: number, pe: number, cc: number, pc: number, prev: number | null) => ({ ce_iv: ce, pe_iv: pe, ce_change: cc, pe_change: pc, risk_reversal: +(ce - pe).toFixed(2), skew: +(pe - ce).toFixed(2), rr_change: +(cc - pc).toFixed(2), rr_previous_session: prev, rr_change_since_previous_session: prev == null ? null : +(ce - pe - prev).toFixed(2), mechanism: "put IV expansion (+0.51) together with call IV contraction (-0.20)" });
const vol: VolDetail = {
  window: "15 min", spot_change_pct: 0.05, atm: { ...vb(15, 15.4, -0.3, -0.24, -0.3), movement: "little changed", avg_change: -0.27 }, d25: vb(14.1, 16.9, -0.2, 0.51, -1.7), d10: vb(13.2, 19, -0.4, 0.9, -4.5),
  total: -32.4, verdict: "CONFLICTING",
  components: [{ key: "atm", name: "ATM IV change against price", reading: "ATM IV -0.27 pts", score: 29.6, contribution: 14.8 }, { key: "rr", name: "Call versus put IV momentum (25Δ)", reading: "risk-reversal change -0.71 pts", score: -94.4, contribution: -47.2 }],
  evidence: { bullish: ["ATM IV change against price +30: ATM IV -0.27 pts"], bearish: ["Call versus put IV momentum (25Δ) -94: risk-reversal change -0.71 pts"], conflicting: ["the components disagree"] }, not_scored: [],
  interpretation: [{ id: "atm", title: "ATM volatility", reading: "little changed: ATM IV -0.27 pts over 15 min" }, { id: "put_side", title: "Put-side IV (25Δ)", reading: "strengthening: +0.51 pts, now 16.90" }, { id: "confirmation", title: "Overall volatility confirmation", reading: "mixed: the volatility components disagree, so volatility does not confirm the price move" }],
  unscored_components: [{ key: "d10", name: "10Δ risk-reversal change", reading: "-1.30 pts", score: null, contribution: 0, scored: false, why: "the 10Δ and 25Δ risk reversals are two points on the same smile tilt; scoring both would count one signal twice" }, { key: "skew", name: "25Δ skew (PE IV − CE IV)", reading: "+2.80", score: null, contribution: 0, scored: false, why: "the skew is the risk reversal with its sign reversed: the same number, not a second signal" }],
  correlated_inputs: ["25Δ risk reversal and 10Δ risk reversal: two points on one smile tilt, highly correlated; only the 25Δ change is scored."],
  explanation: "Volatility evidence is CONFLICTING (group score -32): ATM IV change against price +30; Call versus put IV momentum (25Δ) -94. The components disagree, so the net score understates the conflict.", scoring: { mode: "legacy", atm_scale: 0.5, atm_factor: 0.6, skew_scale: 0.4 },
  sign_convention: "risk reversal = CE IV − PE IV; skew = PE IV − CE IV = −risk reversal", sign_consistent: true,
};

describe("Volatility evidence", () => {
  it("shows separate CE and PE readings, risk reversals now and at the previous close, ATM apart from skew, each contribution and why the verdict is conflicting", async () => {
    view({ ...base, engines: base.engines.map((e) => (e.key === "volatility" ? { ...e, detail: vol } : e)) });
    const v = await screen.findByTestId("vol-evidence");
    expect(within(v).getByTestId("vol-verdict").textContent).toBe("CONFLICTING");
    const row = within(v).getByTestId("vol-row-25Δ");
    expect(row.textContent).toContain("14.10");
    expect(row.textContent).toContain("16.90");
    expect(row.textContent).toContain("−2.80"); // risk reversal now
    expect(row.textContent).toContain("−1.70"); // previous close
    expect(row.textContent).toContain("+2.80"); // skew = PE − CE
    expect(within(v).getByTestId("vol-row-10Δ").textContent).toContain("−5.80"); // 10Δ kept apart from 25Δ
    expect(within(v).getByTestId("vol-row-ATM").textContent).toContain("−0.30");
    const c = within(v).getByTestId("vol-components").textContent ?? "";
    expect(c).toContain("+30");
    expect(c).toContain("−94");
    expect(c).toContain("−47.2");
    expect(within(v).getByTestId("vol-explanation").textContent).toContain("The components disagree");
    expect(within(v).getByTestId("vol-evidence-lists").textContent).toContain("Conflicting");
    expect(within(v).getByTestId("vol-interpretation").textContent).toContain("strengthening: +0.51 pts, now 16.90");
    expect(within(v).getByTestId("vol-sign").textContent).toContain("not about direction");
    expect(v.textContent).toContain("ATM little changed");
    const un = within(v).getByTestId("vol-unscored-d10");
    expect(un.textContent).toContain("not scored");
    expect(un.textContent).toContain("one signal twice");
    expect(within(v).getByTestId("vol-unscored-skew").textContent).toContain("the same number");
    expect(within(v).getByTestId("vol-correlated").textContent).toContain("only the 25Δ change is scored");
    expect(within(v).getByTestId("vol-correlated").textContent).toContain("is noise and is not counted as evidence");
  });
});

describe("Intraday ML panel", () => {
  it("says what the model does, where it stands, how it scored against the baselines and why it is not trusted yet", async () => {
    view(base);
    const p = await screen.findByTestId("ml-panel");
    expect(within(p).getByTestId("ml-what").textContent).toContain("tested against simple baselines on later sessions only");
    expect(within(p).getByTestId("ml-stage").textContent).toBe("Collecting labelled data");
    expect(p.textContent).toContain("2 to go");
    expect(within(p).getByTestId("ml-verdict").textContent).toBe("Experimental");
    expect(p.textContent).toContain("no probability is shown");
    const t = within(p).getByTestId("ml-table");
    expect(t.textContent).toContain("Majority class");
    expect(t.textContent).toContain("1.0912");
    expect(t.textContent).toContain("Logistic model (all features)");
    expect(within(p).getByTestId("ml-gain").textContent).toContain("0.0122 worse");
    expect(within(p).getByTestId("ml-reasons").textContent).toContain("only 8 labelled sessions");
    expect(within(p).getByTestId("ml-groups").textContent).toContain("options −0.0021");
    expect(p.textContent).toContain("research only, not part of the sentiment score");
    expect(within(p).getByRole("link", { name: /intraday analysis/ }).getAttribute("href")).toBe("/analysis");
  });
  it("says plainly when no evaluation has been stored yet, and when the service did not answer", async () => {
    view({ ...base, intraday_ml: { ...ml, last_evaluation: null } });
    expect((await screen.findByTestId("ml-none")).textContent).toContain("No evaluation has been stored yet");
    expect(screen.getByTestId("ml-verdict").textContent).toBe("Not evaluated yet");
  });
  it("shows an explicit state when the research service is not answering", async () => {
    view({ ...base, intraday_ml: null });
    expect((await screen.findByTestId("ml-panel")).textContent).toContain("did not answer");
  });
});

describe("Heavyweight Intelligence panel", () => {
  it("shows each stock with weight, price change, CVD proxy, momentum, VWAP, bias and feed freshness", async () => {
    view(base);
    const panel = await screen.findByTestId("hw-panel");
    expect(within(panel).getByTestId("hw-proxy").textContent).toBe("CVD PROXY");
    const row = within(panel).getByTestId("hw-row-HDFCBANK");
    expect(row.textContent).toContain("HDFC Bank Ltd.");
    expect(row.textContent).toContain("13.10%");
    expect(row.textContent).toContain("was 12.40%"); // the previous index weight
    expect(row.textContent).toContain("+0.40%");
    expect(row.textContent).toContain("+20.0% session");
    expect(row.textContent).toContain("15 min +20.0%");
    expect(row.textContent).toContain("accel −2.0");
    expect(row.textContent).toContain("1,495.00");
    expect(row.textContent).toContain("Buying · above VWAP (confirmed)");
    expect(row.textContent).toContain("live · 3 s");
    expect(row.textContent).toContain("CVD PROXY");
    expect(within(panel).getByTestId("hw-row-ICICIBANK").textContent).toContain("Selling · below VWAP (confirmed)");
  });
  it("marks an unavailable stock instead of substituting another, and never presents a partial aggregate as five stocks", async () => {
    view(base);
    const panel = await screen.findByTestId("hw-panel");
    const tcs = within(panel).getByTestId("hw-row-TCS");
    expect(tcs.textContent).toContain("STALE · 600 s");
    expect(tcs.textContent).toContain("No reading");
    expect(within(panel).getByTestId("hw-quality").textContent).toContain("4 of 5 heavyweights valid");
    expect(panel.textContent).toContain("4 of 5 stocks (PARTIAL)");
    expect(panel.textContent).toContain("unavailable: 0 of 5 stocks valid (need 3 and 60% of the weight)"); // the 30-minute aggregate
  });
  it("says in words why the whole-day aggregate is not shown, and lists the stocks as cards for a phone", async () => {
    const part = hw.stocks.map((x, i) => (i < 2 ? { ...x, session: { ...x.session, norm: null } } : x));
    view({ ...base, heavyweights: { ...hw, stocks: part, aggregate: { ...hw.aggregate, session: { score: null, valid: 3, of: 5, weight_share: 0.573, status: "unavailable: 3 of 5 stocks valid (need 3 and 60% of the weight)" } } } });
    const panel = await screen.findByTestId("hw-panel");
    const why = within(panel).getByTestId("hw-session-why");
    expect(why).toHaveTextContent("only 3 of 5 stocks have a full-day reading");
    expect(why).toHaveTextContent("HDFCBANK, RELIANCE");
    expect(why).toHaveTextContent("57% of the weight and the rule needs at least 60%");
    expect(within(panel).getByTestId("hw-cards").querySelectorAll("li")).toHaveLength(5);
    expect(within(panel).getByTestId("hw-cards")).toHaveTextContent("part-day only");
  });
  it("shows the aggregate windows, momentum, acceleration, participation breadth and NIFTY context", async () => {
    view(base);
    const panel = await screen.findByTestId("hw-panel");
    expect(panel.textContent).toContain("Aggregate session");
    expect(panel.textContent).toContain("+38");
    expect(panel.textContent).toContain("+52");
    expect(panel.textContent).toContain("+11.0"); // aggregate momentum
    expect(panel.textContent).toContain("+4.0"); // aggregate acceleration
    const part = within(panel).getByTestId("hw-participation");
    expect(part.textContent).toContain("Broad heavyweight buying");
    expect(part.textContent).toContain("3 buying · 1 selling · 0 neutral of 4 valid");
    expect(part.textContent).toContain("largest HDFCBANK (45% of that side)");
    expect(within(panel).getByTestId("hw-nifty").textContent).toContain("+0.12%");
    expect(within(panel).getByTestId("hw-nifty").textContent).toContain("above");
    expect(panel.querySelectorAll('[role="img"]').length).toBe(2); // the aggregate-versus-NIFTY chart and the five-stock contribution chart
  });
  it("warns that the index weights are stale and says where they came from", async () => {
    view(base);
    expect((await screen.findByTestId("hw-stale-weights")).textContent).toContain("132 days old");
    expect(screen.getByTestId("hw-quality").textContent).toContain("effective 2026-06-30, source NSE index tracker");
  });
  it("shows an explicit unavailable state when no heavyweight flow is tracked", async () => {
    view({ ...base, heavyweights: { ...hw, available: false, reason: "no heavyweight flow is tracked yet", stocks: [] } });
    expect((await screen.findByTestId("hw-panel")).textContent).toContain("Nothing is estimated in its place");
  });
  it("lists the divergence signals with their evidence and timestamp in the divergence panel", async () => {
    const sig = { id: "hw_up_cvd_down", name: "NIFTY rising while heavyweight CVD falls", direction: "bearish", severity: "medium" as const, kind: "divergence" as const, reading: "NIFTY +0.30% while aggregate heavyweight CVD proxy is -40", explanation: "The index is rising against estimated selling pressure in its five largest stocks.", invalidation: "aggregate CVD turns positive or NIFTY stops rising",
      evidence: ["aggregate 15-min -40", "NIFTY +0.30% (15 min)", "participation: Heavyweight divergence"], at: "2026-11-09T04:29:58Z", status: "early warning" as const, since: null, previous: null };
    view({ ...base, divergences: [sig] });
    const ev = await screen.findByTestId("mi-div-evidence");
    expect(ev.textContent).toContain("aggregate 15-min -40");
    expect(ev.textContent).toContain("participation: Heavyweight divergence");
    expect(ev.textContent).toContain("as of");
  });
});

describe("Home", () => {
  it("opens with the compact market strip and still lists every tool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(base), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Home /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "NIFTY 50 command centre" })).toBeTruthy();
    expect((await screen.findByTestId("mi-class")).textContent).toBe("Bullish");
    expect(screen.queryByTestId("mi-pulses")).toBeNull(); // the home strip is compact: no pulse grid
    expect(screen.getByRole("link", { name: /Market Intelligence/ }).getAttribute("href")).toBe("/market-intelligence");
    expect(screen.getByRole("searchbox", { name: "Search tools" })).toBeTruthy();
  });
  it("still works when the market summary is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code: "x", message: "down" } }), { status: 503 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Home /></MemoryRouter></QueryClientProvider>);
    expect((await screen.findByTestId("home-no-intel")).textContent).toContain("The tools below still work");
    expect(screen.getByRole("searchbox", { name: "Search tools" })).toBeTruthy();
  });
});
