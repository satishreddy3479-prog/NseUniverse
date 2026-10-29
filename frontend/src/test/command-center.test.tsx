// The command center renders exactly what the backend computed. The payload in intraday-summary.json
// was produced by the real backend service from the PC's stored daily history and FII/DII figures
// plus the real captured Kotak chain recorded as 09:15–09:54 samples (scripted in the backend tests).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCenter, ScoreBar } from "../components/CommandCenter";
import type { IntradaySummary } from "../lib/types";
import real from "./intraday-summary.json";

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
    expect(within(ev).getByText(/Unavailable — no NIFTY 50 constituent feed/)).toBeInTheDocument();
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
