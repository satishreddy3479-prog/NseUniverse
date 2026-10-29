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

function mock(summary: IntradaySummary | null, scores: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/intraday/summary")) {
      return summary ? new Response(JSON.stringify(summary), { status: 200 })
        : new Response(JSON.stringify({ detail: { code: "internal_error", message: "internal server error" } }), { status: 500 });
    }
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
