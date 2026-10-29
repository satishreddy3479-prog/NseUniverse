// The command center renders exactly what the backend computed. The payload in intraday-summary.json
// was produced by the real backend service from the PC's stored daily history and FII/DII figures
// plus the real captured Kotak chain recorded as 09:15–09:54 samples (scripted in the backend tests).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCenter, ScoreBar } from "../components/CommandCenter";
import type { IntradaySummary, MarketSummary } from "../lib/types";
import real from "./intraday-summary.json";
// STAND-IN stock prices (layout and arithmetic only; no real stock ticks have been captured yet)
import standin from "./market-summary.standin.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const base = real as unknown as IntradaySummary;

let paper: unknown = { sessions: 0, trades: 0, min_trades_for_a_conclusion: 30, conclusion: "no trades were triggered on the stored sessions", net_rupees: 0 };
let replayResult: unknown = {};
let research: unknown = { status: "insufficient", sessions: 1, rows: 0, horizon_minutes: 15, reason: "needs more than 3 labelled sessions to test on a later one (has 1)" };

function mock(summary: IntradaySummary | null, scores: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/intraday/summary")) {
      return summary ? new Response(JSON.stringify(summary), { status: 200 })
        : new Response(JSON.stringify({ detail: { code: "internal_error", message: "internal server error" } }), { status: 500 });
    }
    if (url.startsWith("/api/intraday/paper")) return new Response(JSON.stringify(paper), { status: 200 });
    if (url.startsWith("/api/intraday/replay?session")) return new Response(JSON.stringify(replayResult), { status: 200 });
    if (url.startsWith("/api/intraday/replay")) return new Response(JSON.stringify({ sessions: [{ session: "2026-10-28", samples: 320, expiries: ["2026-11-03"] }] }), { status: 200 });
    if (url.startsWith("/api/intraday/research")) return new Response(JSON.stringify(research), { status: 200 });
    if (url.startsWith("/api/intraday/scores")) return new Response(JSON.stringify({ session: "2026-10-29", expiry: "2026-11-03", rows: scores }), { status: 200 });
    return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
}

function renderCC(expiry: string | null = "2026-11-03") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CommandCenter expiry={expiry} /></QueryClientProvider>);
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("Market Sentiment Command Center", () => {
  it("shows the backend's label, narrative, coverage and that the model is not trained", async () => {
    mock(base);
    renderCC();
    expect(await screen.findByTestId("cc-label")).toHaveTextContent(base.assessment.label);
    expect(screen.getByTestId("cc-narrative")).toHaveTextContent(base.narrative);
    expect(screen.getByText(`${Math.round(base.assessment.coverage * 100)}%`)).toBeInTheDocument();
    const ml = within(screen.getByTestId("cc-ml"));
    expect(ml.getByText("No model yet")).toBeInTheDocument();
    expect(ml.getByRole("list", { name: "Intraday model stages" }).children).toHaveLength(4);
    expect(ml.getByText(/session\(s\) of labelled data stored/)).toBeInTheDocument();
    expect(screen.getByText("Not calibrated")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/demo|mock/i);
  });

  it("lists unavailable evidence with its reason instead of a zero", async () => {
    mock(base);
    renderCC();
    const ev = await screen.findByTestId("cc-evidence");
    expect(within(ev).getAllByText(/Unavailable — stock breadth is turned off or not running/)).toHaveLength(2); // breadth and sectors
    expect(screen.getByText(/Missing from the score: Market breadth, Sector participation/)).toBeInTheDocument();
  });

  it("expands a factor to show its formula, inputs and source", async () => {
    mock(base);
    renderCC();
    const btn = await screen.findByRole("button", { name: /Options positioning/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Kotak option chain, ATM \+\/-10 strikes/)).toBeInTheDocument();
    expect(screen.getByText(/PCR \(OI\) change since first sample/)).toBeInTheDocument();
  });

  it("labels scenarios as qualitative with no probability", async () => {
    mock(base);
    renderCC();
    await screen.findByTestId("cc-regime");
    expect(screen.getAllByText(/Probability: not estimated/).length).toBe(base.scenarios.length);
    expect(screen.queryByText(/\d+% chance/)).toBeNull();
  });

  it("shows only the supported scenarios and explains the ones ruled out", async () => {
    mock(base);
    renderCC();
    await screen.findByTestId("cc-regime");
    expect(base.scenarios.length + base.scenarios_ruled_out.length).toBe(3);
    expect(screen.getAllByText(/Probability: not estimated/).length).toBe(base.scenarios.length);
    const note = screen.getByTestId("cc-ruled-out");
    for (const r of base.scenarios_ruled_out) {
      expect(within(note).getByText(`Not shown: ${r.name}`)).toBeInTheDocument();
      expect(note.textContent).toContain(r.reason);
    }
    // a ruled-out scenario is not also drawn as a card
    expect(screen.queryAllByText(base.scenarios_ruled_out[0]!.name, { selector: "span.text-sm" })).toHaveLength(0);
  });

  it("says stock breadth is off when the backend does not provide it", async () => {
    mock(base);
    renderCC();
    await screen.findByTestId("cc-regime");
    expect(base.stocks).toBeNull();
    expect(screen.getByText("Stock breadth is turned off on this backend.")).toBeInTheDocument();
    expect(screen.getAllByText("Stock breadth is turned off.", { selector: "p" })).toHaveLength(3); // heavyweights, flow and sectors cards
  });

  it("shows breadth, move quality, heavyweights and sectors from the backend's numbers", async () => {
    const stocks = standin as unknown as MarketSummary;
    mock({ ...base, stocks });
    renderCC();
    await screen.findByTestId("cc-regime");
    expect(screen.getByRole("img", { name: /NIFTY 50: 6 up, 0 flat, 2 down of 8 priced/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /NIFTY 500: 6 up, 0 flat, 2 down of 8 priced/ })).toBeInTheDocument();
    const mq = screen.getByTestId("cc-move-quality");
    expect(mq).toHaveTextContent(stocks.nifty50.quality.reasons[0]!);
    expect(mq).toHaveTextContent("provisional rule");
    expect(screen.getByText("Thin: low volume")).toBeInTheDocument();
    const hw = within(screen.getByTestId("cc-heavyweights"));
    expect(hw.getAllByRole("row").length).toBe(1 + stocks.nifty50.stocks.filter((x) => x.change_pct != null).slice(0, 10).length);
    const top = stocks.nifty50.stocks[0]!;
    expect(hw.getByText(top.symbol)).toBeInTheDocument();
    const sec = within(screen.getByTestId("cc-sectors"));
    expect(sec.getByText("Financial Services")).toBeInTheDocument();
  });

  it("shows futures flow and the top-5 stocks, labelled as estimated, with missing values as dashes", async () => {
    const stocks = standin as unknown as MarketSummary;
    mock({ ...base, stocks });
    renderCC();
    const flow = within(await screen.findByTestId("cc-flow"));
    expect(flow.getByText(/NIFTY current-month future \(NIFTY26NOVFUT\)/)).toBeInTheDocument();
    expect(flow.getByText(/Net buying \(CVD, estimated\)/)).toBeInTheDocument();
    const fut = stocks.flow!.futures!;
    expect(flow.getAllByText(new RegExp(`${fut.cvd}`)).length).toBeGreaterThan(0);
    expect(flow.getByText(/Volume vs normal needs 5 recorded sessions/)).toBeInTheDocument();
    const t = within(screen.getByTestId("cc-heavy5"));
    expect(t.getAllByRole("row").length).toBe(1 + stocks.flow!.heavy5.stocks.length);
    expect(flow.getByText(/the 50-day trend needs 50 sessions/)).toBeInTheDocument();
  });

  it("shows the opening-range breakout status, quality and VWAP, and says when inputs are missing", async () => {
    const structure = {
      as_of: "2026-10-29T05:00:00Z", data: "LIVE", completed_minutes: 20, candle_note: "sampled",
      ranges: [{ minutes: 15, state: "complete", high: 102, low: 100, mid: 101, width: 2 }],
      breakout: { direction: "up", status: "CONFIRMED", first_minute: 15, beyond: 4, clear: 4, extension_ow: 1.45, last_price: 104.9, invalidation: 102, or_minutes: 15,
        quality: { score: 94.1, coverage: 0.85, components: {}, missing: ["volume"], weights: {}, is_probability: false } },
      structure: { label: "uptrend (higher highs, higher lows)", last_swing_high: 16, last_swing_low: 11, break: null, swing_rule: "x" },
    };
    const vwap = { price: 24990, vwap: 24950, distance_pts: 40, distance_pct: 0.16, distance_atr: null, side: "above", slope_pts_per_15m: 3.5, crosses: 2, minutes_above: 30, minutes_below: 10, events: [], samples: 40, note: "" };
    mock({ ...base, structure, vwap } as never);
    renderCC();
    const st = within(await screen.findByTestId("cc-breakout-status"));
    expect(st.getByText("CONFIRMED")).toBeInTheDocument();
    expect(st.getByText(/Quality 94 \/ 100/)).toBeInTheDocument();
    expect(st.getByText(/a score, not a probability/)).toBeInTheDocument();
    expect(st.getByText(/Invalid if a close returns through 102.00. Not available: volume./)).toBeInTheDocument();
    expect(screen.getByTestId("cc-vwap")).toHaveTextContent("above by 40.0 pts (0.16%) · 2 crosses · VWAP +3.5 in 15 min");
  });

  it("gives no breakout call for stored data and no VWAP without a futures feed", async () => {
    const structure = { as_of: "x", data: "HISTORICAL", completed_minutes: 0, candle_note: "", ranges: [{ minutes: 15, state: "complete", high: 102, low: 100, mid: 101, width: 2 }], breakout: null, structure: null };
    mock({ ...base, structure, vwap: null } as never);
    renderCC();
    expect(await screen.findByText("Stored data only: no breakout call.")).toBeInTheDocument();
    expect(screen.getByTestId("cc-vwap")).toHaveTextContent("not available (no futures feed)");
  });

  it("shows implied volatility with its assumptions, and the reason when it cannot be computed", async () => {
    const volatility = { status: "ok", model: "Black-76; forward from put-call parity", rate_assumed: 0.06, time_to_expiry_days: 5.2, data: "LIVE", forward: 22703.85, forward_source: "put-call parity at 22700",
      atm_strike: 22700, atm_iv: 16.54, skew_25d_put_minus_call: 1.29, iv_change_pts: { "5": 0.1, "15": -0.4, "30": null }, realized_vol_60m: 12.1, iv_minus_realized: 4.4,
      expected_move_straddle_pts: 358, expected_move_iv_1sd_pts: 450, interpretation: ["Underlying rising while IV falls (calls being repriced lower in volatility: a calm advance)."],
      rows: [{ strike: 22700, side: "CE", price: 190, otm: true, iv: 16.5, delta: 0.52, gamma: 0.00045, theta_day: -18.2, vega_pt: 11.9 }] };
    mock({ ...base, volatility } as never);
    renderCC();
    const box = within(await screen.findByTestId("cc-vol"));
    expect(box.getByText("16.54%")).toBeInTheDocument();
    expect(box.getByText(/\+0.10 \/ −0.40 \/ — pts/)).toBeInTheDocument();
    expect(box.getByText(/Implied, not a forecast/)).toBeInTheDocument();
    expect(box.getByText(/not validated against a broker reference/)).toBeInTheDocument();
    expect(within(screen.getByTestId("cc-greeks")).getByText("0.520")).toBeInTheDocument();
  });

  it("says why implied volatility is missing instead of showing numbers", async () => {
    mock({ ...base, volatility: { status: "not computed: less than 15 minutes to expiry (or expired)" } } as never);
    renderCC();
    expect(await screen.findByTestId("cc-vol-missing")).toHaveTextContent("not computed: less than 15 minutes to expiry");
  });

  it("shows stock participation: VWAP, opening range and breadth divergence", async () => {
    const stocks = JSON.parse(JSON.stringify(standin)) as MarketSummary;
    stocks.participation = {
      above_vwap: { above: 3, below: 3, at: 1, covered: 7, missing: 1, pct_above: 42.9 },
      opening_range: { above_high: 1, below_low: 1, inside: 1, covered: 3, missing: 5, pct_above_high: 33.3, pct_below_low: 33.3, minutes: 15 },
      momentum: { window_minutes: 15, breadth_momentum: -0.4, index_move_pct: 0.3, state: "bearish_divergence" },
    };
    mock({ ...base, stocks });
    renderCC();
    const box = within(await screen.findByTestId("cc-participation"));
    expect(box.getByText(/Above own day VWAP: 42.9% \(3 of 7\) · 1 without a VWAP/)).toBeInTheDocument();
    expect(box.getByText(/5 without a recorded range/)).toBeInTheDocument();
    expect(box.getByText(/Breadth momentum \(15 min\): −0.40. Index rising while fewer stocks take part \(bearish divergence\)/)).toBeInTheDocument();
  });

  it("shows window PCRs, the tentative premium/OI reading with its limits, and the term structure", async () => {
    const positioning = { status: "ok", reference_minutes: 15,
      pcr_windows: { atm_pm2: { strikes: 5, pcr_oi: 0.91, pcr_volume: 0.87, ce_oi: 1, pe_oi: 1 }, all: { strikes: 40, pcr_oi: null, pcr_volume: 1.1, ce_oi: 0, pe_oi: 1 } },
      oi_change_pcr_since_open: { value: null, reason: "call OI did not increase, so the ratio is not meaningful" },
      classification: { available: true, limits: "Tentative: aggregate OI does not show who bought or sold.", calls: { label: "Falling premium, rising OI", reading: "new writing more likely", reason: null }, puts: { label: null, reading: null, reason: "no strike has both samples" } },
      concentration: { calls: { top3_share: 0.62, max_strike: 23000 }, puts: { top3_share: null, max_strike: null }, note: "x" } };
    const volatility = { status: "ok", atm_iv: 16.5, term_structure: { rows: [{ expiry: "2026-11-03", days: 5.2, atm_iv: 16.5 }, { expiry: "2026-11-24", days: 26.2, atm_iv: 17.9 }], shape: "upward (far expiry richer)", iv_far_minus_near: 1.4, reason: null } };
    mock({ ...base, positioning, volatility } as never);
    renderCC();
    const box = within(await screen.findByTestId("cc-pos"));
    expect(box.getByText("ATM ±2")).toBeInTheDocument();
    expect(box.getByText("Falling premium, rising OI (new writing more likely)")).toBeInTheDocument();
    expect(box.getByText("no strike has both samples")).toBeInTheDocument();
    expect(box.getByText(/aggregate OI does not show who bought or sold/)).toBeInTheDocument();
    expect(box.getByText(/call OI did not increase, so the ratio is not meaningful/)).toBeInTheDocument();
    expect(screen.getByTestId("cc-term")).toHaveTextContent("upward (far expiry richer), far minus near 1.40 pts (2026-11-03 16.5%, 2026-11-24 17.9%)");
  });

  it("says there is not enough data for the prediction model and shows no probabilities", async () => {
    mock(base);
    renderCC();
    const box = within(await screen.findByTestId("cc-research"));
    expect(box.getByText(/Insufficient data/)).toBeInTheDocument();
    expect(box.getByText(/needs more than 3 labelled sessions to test on a later one \(has 1\). No probabilities are shown./)).toBeInTheDocument();
    expect(screen.queryByText(/upside probability/i)).toBeNull();
  });

  it("labels an unvalidated model as experimental and lists the baselines it is compared with", async () => {
    research = {
      status: "experimental", sessions: 8, rows: 960, horizon_minutes: 15,
      gate: { status: "experimental", show_probabilities: false, reasons: ["only 8 labelled sessions (validation needs 20)"], label: "EXPERIMENTAL MODEL: PROBABILITIES NOT VALIDATED" },
      models: { majority: { log_loss: 1.097, brier: 0.66, accuracy: 0.37, balanced_accuracy: 0.333, n: 600, calibration: { ece: 0.01 } }, logistic: { log_loss: 0.295, brier: 0.15, accuracy: 0.977, balanced_accuracy: 0.97, n: 600, calibration: { ece: 0.14 } } },
      note: "Overlapping samples are not independent.",
    };
    mock(base);
    renderCC();
    const box = within(await screen.findByTestId("cc-research"));
    expect(box.getByText(/EXPERIMENTAL MODEL: PROBABILITIES NOT VALIDATED/)).toBeInTheDocument();
    expect(box.getByText(/only 8 labelled sessions/)).toBeInTheDocument();
    expect(box.getByText("majority")).toBeInTheDocument();
    expect(box.getByText("0.295")).toBeInTheDocument();
    research = { status: "insufficient", sessions: 1, rows: 0, horizon_minutes: 15, reason: "needs more than 3 labelled sessions to test on a later one (has 1)" };
  });

  it("shows the setup monitor as read-only, with the reasons a rule was not taken and no probability", async () => {
    const setups = { decision: "NO TRADE: INSUFFICIENT EVIDENCE", active: 0, read_only: true, global_blockers: ["daily trade limit (4) reached"], note: "Rule-based decision support. No orders are placed.",
      candidates: [{ setup: "OR_BREAKOUT", direction: "long", status: "BLOCKED", entry_condition: "already confirmed", entry_ref: 24047, stop: 24040, target: 24080, reward_risk: 4.71, lots: 4, max_loss_rs: 1820, costs_pts: 15.4,
        probability: null, probability_note: "not shown: no validated model", data_quality: "LIVE", reason: "break confirmed", invalidation: "a close back through 24040.00", rejected_because: [], blocked_because: ["daily trade limit (4) reached"] }] };
    mock({ ...base, setups } as never);
    renderCC();
    const box = within(await screen.findByTestId("cc-setups"));
    expect(box.getByTestId("cc-setup-decision")).toHaveTextContent("NO TRADE: INSUFFICIENT EVIDENCE");
    const row = within(box.getByTestId("cc-setup"));
    expect(row.getByText("BLOCKED")).toBeInTheDocument();
    expect(row.getByText(/Entry ~24047 · stop 24040 · target 24080 · reward\/risk 4.71 · 4 lot\(s\), max loss ₹1820/)).toBeInTheDocument();
    expect(row.getByText(/Not taken: daily trade limit \(4\) reached/)).toBeInTheDocument();
    expect(box.getByText(/No orders are placed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/probability of|% chance/i);
  });

  it("shows paper-trading results with the no-conclusion rule", async () => {
    paper = { sessions: 6, trades: 4, min_trades_for_a_conclusion: 30, conclusion: "no conclusion: 4 trades is fewer than 30; the result below is noise-sized", net_rupees: -1250, gross_rupees_before_costs: 900, costs_and_slippage_rupees: 2150, win_rate: 0.25, expectancy_rupees: -312.5, profit_factor: 0.4, max_drawdown_rupees: 2000 };
    mock(base);
    renderCC();
    const box = within(await screen.findByTestId("cc-paper"));
    expect(box.getByText(/4 trade\(s\) over 6 session\(s\)/)).toBeInTheDocument();
    expect(box.getByText(/no conclusion: 4 trades is fewer than 30/)).toBeInTheDocument();
    expect(box.getByText(/Net ₹-1250 \(₹900 before ₹2150 of costs and slippage\)/)).toBeInTheDocument();
    paper = { sessions: 0, trades: 0, min_trades_for_a_conclusion: 30, conclusion: "no trades were triggered on the stored sessions", net_rupees: 0 };
  });

  it("replays a past moment and keeps what happened afterwards visibly separate", async () => {
    replayResult = { status: "ok", replay: true, session: "2026-10-28", at: "2026-10-28T10:30:00+05:30", last_sample_at: "2026-10-28T10:30:00+05:30",
      summary: { ...base, structure: { ...(base.structure ?? {}), breakout: null }, setups: { decision: "NO TRADE: INSUFFICIENT EVIDENCE", active: 0, candidates: [], global_blockers: [], read_only: true } },
      after_the_fact: { "5": { outcome: "none" }, "15": { outcome: "up", minutes_to_touch: 7 }, "30": { outcome: "ambiguous", reason: "9.0 minute gap before the touch" } }, after_the_fact_note: "none of it was known" };
    mock(base);
    renderCC();
    await screen.findByTestId("cc-replay");
    const btn = await screen.findByRole("button", { name: "Show the dashboard as it was" });
    btn.click();
    const out = within(await screen.findByTestId("cc-replay-result"));
    expect(out.getByText(/After the fact \(not known at the time shown\)/)).toBeInTheDocument();
    expect(out.getByText(/15 min: up after 7 min/)).toBeInTheDocument();
    expect(out.getByText(/30 min: ambiguous \(9.0 minute gap before the touch\)/)).toBeInTheDocument();
    replayResult = {};
  });

  it("explains that futures are not subscribed instead of inventing flow", async () => {
    const stocks = JSON.parse(JSON.stringify(standin)) as MarketSummary;
    stocks.flow!.futures = null;
    stocks.flow!.futures_note = "NIFTY futures not subscribed: the monthly expiry is not known yet";
    mock({ ...base, stocks });
    renderCC();
    expect(await screen.findByText(/NIFTY futures not subscribed: the monthly expiry is not known yet/)).toBeInTheDocument();
  });

  it("explains which source is missing when no stock prices are streaming", async () => {
    const stocks = JSON.parse(JSON.stringify(standin)) as MarketSummary;
    stocks.nifty50.breadth = { ...stocks.nifty50.breadth, covered: 0, advancing: 0, declining: 0, flat: 0 };
    stocks.sources.live = { stocks_with_ticks: 0, subscribed: 508 };
    stocks.sources.weights = null;
    mock({ ...base, stocks });
    renderCC();
    const list = within(await screen.findByTestId("cc-breadth-sources"));
    expect(list.getByText("○ Live stock prices")).toBeInTheDocument();
    expect(list.getByText("0 of 508 streaming")).toBeInTheDocument();
    expect(list.getByText("○ Index weights")).toBeInTheDocument();
    expect(screen.getByText(/breadth cannot be measured. It is not guessed/)).toBeInTheDocument();
  });

  it("shows VWAP as not available for an index", async () => {
    mock(base);
    renderCC();
    const row = (await screen.findByText("VWAP")).closest("tr")!;
    expect(within(row).getByText("n/a")).toBeInTheDocument();
    expect(row.getAttribute("title")).toMatch(/no traded volume/);
  });

  it("warns when the values are not live", async () => {
    mock({ ...base, market: { ...base.market, mode: "historical", phase: "post_market" } });
    renderCC();
    expect(await screen.findByTestId("cc-mode-note")).toHaveTextContent(/not live/);
  });

  it("insufficient data shows no score and no scenarios", async () => {
    mock({ ...base, assessment: { ...base.assessment, score: null, label: "Insufficient data", direction: "Unknown" }, scenarios: [] });
    renderCC();
    expect(await screen.findByTestId("cc-label")).toHaveTextContent("Insufficient data");
    expect(screen.getByText(/No scenarios: there is no current assessment/)).toBeInTheDocument();
  });

  it("reports a backend failure without hiding the rest of the page", async () => {
    mock(null);
    renderCC();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be computed.*widgets below still work/);
  });

  it("can be hidden and remembers it", async () => {
    mock(base);
    renderCC();
    await screen.findByTestId("cc-label");
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("cc-label")).toBeNull();
    expect(localStorage.getItem("nse.intraday.cc.hidden")).toBe("1");
  });

  it("score bar is an accessible meter and handles missing", () => {
    render(<><ScoreBar value={-0.4} label="a" /><ScoreBar value={null} label="b" /></>);
    expect(screen.getByRole("meter", { name: "a" })).toHaveAttribute("aria-valuetext", "-0.40");
    expect(screen.getByRole("meter", { name: "b" })).toHaveAttribute("aria-valuetext", "not available");
  });

  // two ledger rows only to exercise the empty/drawn switch; the chart stub does not plot them
  it("draws the stored score history once two scores exist", async () => {
    mock(base, [
      { sample_utc: "2026-10-29T03:50:00+00:00", spot: 22700, score: 0.1, label: "Neutral / range-bound", coverage: 0.75, regime: "x" },
      { sample_utc: "2026-10-29T03:51:00+00:00", spot: 22710, score: null, label: "Insufficient data", coverage: 0.3, regime: "x" },
    ]);
    renderCC();
    expect(await screen.findByRole("img", { name: /Sentiment score and sampled NIFTY/ })).toBeInTheDocument();
  });
});
