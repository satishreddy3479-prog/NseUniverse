// NIFTY 50 Market Intelligence page: renders what the aggregation service returned, and says plainly what is missing. Numbers are fixtures.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketIntelligence } from "../pages/MarketIntelligence";
import { Home } from "../pages/Home";
import type { EngineView, Intelligence, Timeline } from "../lib/intelligence";

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
    futures: { series: { future: 24148, basis: 48 }, contract: "NIFTY26NOVFUT", oi_change: 52000, volume: 900000, buildup: "long buildup", flow: { cvd_pct: 25, classified_share: 0.9, depth_imbalance: 0.1 }, vwap: { vwap: 24050, distance_pct: 0.2, slope_pts_per_15m: 4 }, rolling: { estimated: true, momentum_per_min: 12.5, ok_windows: 2, windows: { "5": { minutes: 5, cvd: 1000, cvd_pct: 20, volume: 5000, classified: 5000, from: "t0", to: "t1", status: "ok" }, "15": { minutes: 15, cvd: 2400, cvd_pct: 16, volume: 15000, classified: 15000, from: "t0", to: "t1", status: "ok" }, "30": { minutes: 30, cvd: null, cvd_pct: null, volume: null, classified: null, from: null, to: "t1", status: "unavailable: fewer than 30 minutes of flow samples stored today" } } }, unavailable: ["rollover data (needs near-month and next-month contract OI and volume history)"], note: "CVD is an estimate by the quote and tick rule." },
    heavyweight: { stocks: [{ symbol: "HDFCBANK", weight: 13, change_pct: 0.4, relative_volume: 1.1, cvd_pct: 20, divergence: null, contribution: 0.05 }], metrics: { weighted_cvd_score: 31, positive_cvd: 4, negative_cvd: 1, stocks_used: [], aggregate_points_pct: 0.09, participation_ratio: 0.8, divergence: null, symbols: ["HDFCBANK"] }, unavailable: ["stock futures and their OI"], note: "The five largest constituents." },
  },
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
    expect(within(strip).getByTestId("mi-provisional").textContent).toContain("not derived from the size of the score");
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
    expect(within(d).getAllByRole("link", { name: /Open the full analysis/ }).map((l) => l.getAttribute("href"))).toEqual(["/tools/strike-positioning", "/tools/gamma-exposure", "/tools/volatility-skew", "/tools/future-flow", "/tools/future-flow"]);
    expect(d.textContent).toContain("not observed dealer positioning");
    expect(d.textContent).toContain("OI does not identify who bought or sold");
    expect(within(screen.getByTestId("mi-heavy")).getByText("HDFCBANK")).toBeTruthy();
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
    expect(r.textContent).toContain("+12.5 per minute");
  });
  it("lists AVAILABLE, PARTIAL and UNAVAILABLE capabilities with source timestamps and links", async () => {
    view(base);
    const c = await screen.findByTestId("mi-capabilities");
    expect(within(c).getByTestId("mi-cap-session_cvd").textContent).toContain("AVAILABLE");
    expect(within(c).getByTestId("mi-cap-session_cvd").textContent).toContain("2026-11-09T04:29:58+00:00");
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
