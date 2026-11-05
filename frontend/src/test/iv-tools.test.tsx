// Options Lab: IV - HV and IV - Intraday render what the backend computed (/api/intraday/hv, /api/intraday/iv-series,
// and the command center's ATM IV from /api/intraday/summary). Numbers here are formula checks, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IvHvBody, IvIntradayBody } from "../components/IvTools";
import { toolById, toolPath } from "../lib/tools";
import type { HvReport, IntradaySummary, IvSeries } from "../lib/types";
import real from "./intraday-summary.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const base = real as unknown as IntradaySummary;
const hv: HvReport = {
  as_of: "2026-11-04", days_behind: 1, bars: 4694,
  windows: { "10": { hv: 12, returns: 10, gap_returns: 0 }, "20": { hv: 10, returns: 20, gap_returns: 1 }, "30": { hv: null, returns: 12, gap_returns: 0 }, "60": { hv: 14, returns: 60, gap_returns: 0 } },
  series: { window: 20, dates: ["2026-11-03", "2026-11-04"], hv: [null, 10] }, method: "x",
};

function mock(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
}
const wrap = (el: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
afterEach(() => vi.unstubAllGlobals());

describe("Options Lab: IV tools", () => {
  it("are ready tools", () => {
    for (const id of ["iv-hv", "iv-intraday"]) {
      expect(toolById(id)?.status).toBe("ready");
      expect(toolPath(toolById(id)!)).toBeTruthy();
    }
  });

  it("IV - HV sets ATM IV against each historical window, leaving a missing window missing", async () => {
    // ATM IV 16.8 against HV10 12.0: gap +4.80 pts, ratio 1.40 (hand calculation)
    mock({ "/api/intraday/hv": hv, "/api/intraday/summary": { ...base, volatility: { status: "ok", atm_iv: 16.8, as_of: "2026-11-05T04:30:00Z" } } });
    wrap(<IvHvBody expiry="2026-11-03" />);
    const t = within(await screen.findByTestId("ivhv-table"));
    const row10 = t.getByText("10 days").closest("tr")!;
    expect(row10).toHaveTextContent("12.00%");
    expect(row10).toHaveTextContent("+4.80 pts");
    expect(row10).toHaveTextContent("1.40");
    expect(t.getByText("20 days").closest("tr")).toHaveTextContent("1 gap in the data");
    expect(t.getByText("30 days").closest("tr")).toHaveTextContent("(needs 30 returns, has 12)");
    expect(screen.getByRole("img", { name: /20-day historical volatility/ })).toBeInTheDocument();
  });

  it("IV - HV says why implied volatility is missing instead of inventing it", async () => {
    mock({ "/api/intraday/hv": hv, "/api/intraday/summary": { ...base, volatility: { status: "not computed: no option-chain sample" } } });
    wrap(<IvHvBody expiry="2026-11-03" />);
    expect(await screen.findByTestId("ivhv-iv-note")).toHaveTextContent("not computed: no option-chain sample");
    expect(within(screen.getByTestId("ivhv-table")).getByText("10 days").closest("tr")).not.toHaveTextContent("pts");
  });

  const series: IvSeries = {
    status: "ok", expiry: "2026-11-03", session: "2026-11-05", is_today: true, samples_in_session: 3, points_shown: 3, thinned_every: 1,
    latest_at: "2026-11-05T04:30:00Z", age_seconds: 60, high: 16.9, low: 16.1, model: "Black-76; forward from put-call parity", rate_assumed: 0.07,
    points: [
      { at: "2026-11-05T04:28:00Z", spot: 24000, atm_iv: 16.1, straddle: 300, skew: 1, note: null },
      { at: "2026-11-05T04:29:00Z", spot: 24010, atm_iv: null, straddle: null, skew: null, note: "not computed" },
      { at: "2026-11-05T04:30:00Z", spot: 24020, atm_iv: 16.9, straddle: 305, skew: 1, note: null },
    ],
  };

  it("IV - Intraday shows latest, change, high and low, and counts the snapshots without an IV", async () => {
    mock({ "/api/intraday/iv-series": series });
    wrap(<IvIntradayBody expiry="2026-11-03" />);
    const stats = within(await screen.findByTestId("ivintraday-stats"));
    expect(stats.getAllByText("16.90%")).toHaveLength(2); // latest and session high
    expect(stats.getByText("+0.80 pts")).toBeInTheDocument(); // 16.9 - 16.1
    expect(stats.getByText("16.10%")).toBeInTheDocument(); // low
    expect(screen.getByText(/1 snapshot\(s\) had no computable IV/)).toBeInTheDocument();
    expect(screen.queryByTestId("ivintraday-stale")).toBeNull();
  });

  it("IV - Intraday warns when the newest snapshot is old and says when nothing is stored", async () => {
    mock({ "/api/intraday/iv-series": { ...series, age_seconds: 900 } });
    wrap(<IvIntradayBody expiry="2026-11-03" />);
    expect(await screen.findByTestId("ivintraday-stale")).toHaveTextContent("15 minutes old");
    vi.unstubAllGlobals();
    mock({ "/api/intraday/iv-series": { status: "no stored option-chain sample for this expiry", points: [] } });
    wrap(<IvIntradayBody expiry="2026-11-10" />);
    expect(await screen.findByTestId("ivintraday-empty")).toHaveTextContent("no stored option-chain sample");
  });
});
