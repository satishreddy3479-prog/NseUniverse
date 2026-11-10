// Futures flow / top-5 heavyweights and sectors now live in Future Lab tools (moved from the Intraday Booster page).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FuturesBuildupBody } from "../components/FuturesBuildupTool";
import { FuturesFlowBody } from "../components/FuturesFlowTools";
import { toolById, toolPath } from "../lib/tools";
import type { IntradaySummary, MarketSummary } from "../lib/types";
import real from "./intraday-summary.json";
// STAND-IN stock prices (layout and arithmetic only; no real stock ticks have been captured yet)
import standin from "./market-summary.standin.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const base = real as unknown as IntradaySummary;

function mock(summary: IntradaySummary) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/intraday/summary")
      ? new Response(JSON.stringify(summary), { status: 200 })
      : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 })));
}
function renderTool(part: "flow" | "sectors") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FuturesFlowBody expiry="2026-11-03" part={part} /></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("Future Lab: flow and sectors", () => {
  it("are registered as ready Future Lab tools", () => {
    for (const id of ["future-flow", "future-sectors"]) {
      const t = toolById(id);
      expect(t?.menu).toBe("fno");
      expect(t?.status).toBe("ready");
      expect(toolPath(t!)).toBeTruthy();
    }
  });

  it("shows sectors from the backend's numbers", async () => {
    mock({ ...base, stocks: standin as unknown as MarketSummary });
    renderTool("sectors");
    const sec = within(await screen.findByTestId("cc-sectors"));
    expect(sec.getByText("Financial Services")).toBeInTheDocument();
  });

  it("says stock breadth is off when the backend does not provide it", async () => {
    mock({ ...base, stocks: null });
    renderTool("flow");
    expect(await screen.findByText("Stock breadth is turned off.", { selector: "p" })).toBeInTheDocument();
  });

  it("shows futures flow and the top-5 stocks, labelled as estimated, with missing values as dashes", async () => {
    const stocks = standin as unknown as MarketSummary;
    mock({ ...base, stocks });
    renderTool("flow");
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


  it("explains that futures are not subscribed instead of inventing flow", async () => {
    const stocks = JSON.parse(JSON.stringify(standin)) as MarketSummary;
    stocks.flow!.futures = null;
    stocks.flow!.futures_note = "NIFTY futures not subscribed: the monthly expiry is not known yet";
    mock({ ...base, stocks });
    renderTool("flow");
    expect(await screen.findByText(/NIFTY futures not subscribed: the monthly expiry is not known yet/)).toBeInTheDocument();
  });

  it("says how much of the day's volume the flow covers and when the last push was", async () => {
    const stocks = JSON.parse(JSON.stringify(standin)) as MarketSummary;
    stocks.flow!.futures!.coverage_of_day_volume = 0.55;
    stocks.flow!.futures!.age_seconds = 400;
    stocks.flow!.futures!.stale = true;
    stocks.flow!.heavy5.stocks[0]!.flow!.coverage_of_day_volume = 0.42;
    mock({ ...base, stocks });
    renderTool("flow");
    const line = await screen.findByTestId("cc-flow-coverage");
    expect(line).toHaveTextContent("covers 55% of today's volume");
    expect(line).toHaveTextContent("STALE: last push 400 s ago");
    expect(screen.getByTestId("cc-heavy5-coverage")).toHaveTextContent(`${stocks.flow!.heavy5.stocks[0]!.symbol} 42%`);
  });
});

describe('Future Lab: price vs open interest', () => {
  it('is a ready Future Lab tool', () => {
    expect(toolById('future-price-oi')).toMatchObject({ menu: 'fno', status: 'ready' });
  });

  it('shows the session reading and the 15-minute windows from the stored futures series, and says when there is none', async () => {
    const series = { day: '2026-11-05', contract: 'NIFTY26NOVFUT', expiry: '2026-11-24', rate_assumed: 0.07,
      times: ['2026-11-05T03:45:00Z', '2026-11-05T03:50:00Z', '2026-11-05T04:01:00Z'], future: [100, 101, 100.5], spot: [], spot_source: [], basis: [], basis_pct: [], carry_pct: [], fair_basis: [], vs_fair: [],
      oi: [1000, 1100, 1050], oi_change: [], oi_per_min: [], volume: [], volume_per_min: [], oi_baseline: null, latest: null, warnings: [], definitions: {} };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(series), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><FuturesBuildupBody /></QueryClientProvider>);
    const session = await screen.findByTestId('buildup-session');
    expect(session).toHaveTextContent('long buildup'); // 100 -> 100.5 and 1000 -> 1050: both up
    expect(within(screen.getByTestId('buildup-table')).getAllByRole('row')).toHaveLength(1 + 2); // header + 09:15 and 09:30 windows
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...series, times: [], warnings: ['No futures samples are stored yet.'] }), { status: 200 })));
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc2}><FuturesBuildupBody /></QueryClientProvider>);
    expect(await screen.findByTestId('buildup-empty')).toHaveTextContent('No futures samples');
  });
});
