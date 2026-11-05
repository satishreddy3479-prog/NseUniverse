// IV / HV / IVP chart: rank maths checked by hand, and the page shows what the backend returned (formula checks, not market data).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IvChartBody } from "../components/IvChartPages";
import { ivpReading, rankAt, rollingRank } from "../lib/ivChart";
import { toolById } from "../lib/tools";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

describe("rank maths", () => {
  const v = [10, 12, 14, 16, 18];
  it("IVR is the position between the range's low and high", () => {
    const r = rankAt(v, 4, 5); // 18 against 10..18
    expect(r.ivr).toBe(100);
    expect(rankAt(v, 2, 3).ivr).toBe(100); // 14 against 10,12,14
    expect(rankAt([10, 20, 15], 2, 3).ivr).toBe(50); // (15-10)/(20-10)
  });
  it("IVP is the share of the range's days below today", () => {
    expect(rankAt([10, 20, 15, 12], 3, 4).ivp).toBe(25); // only 10 is below 12: 1 of 4
    expect(rankAt([10, 20, 15, 30], 3, 4).ivp).toBe(75); // 10, 20, 15 below 30
  });
  it("gives nothing until the range is full or when too many days are missing", () => {
    expect(rankAt(v, 3, 5).ivr).toBeNull();
    expect(rankAt([10, null, null, null, 18], 4, 5).ivp).toBeNull(); // 2 of 5 days is under 80%
    expect(rollingRank(v, 3).ivp).toEqual([null, null, 100 * (2 / 3), 100 * (2 / 3), 100 * (2 / 3)]);
  });
  it("describes the percentile and says when it is unknown", () => {
    expect(ivpReading(85, "1Y")).toContain("higher than on 85% of days in the last 1Y: high");
    expect(ivpReading(10, "3M")).toContain("low");
    expect(ivpReading(null, "1Y")).toContain("Not enough history");
  });
});

describe("IV / HV / IVP page", () => {
  it("is a ready tool", () => expect(toolById("iv-hvp")?.status).toBe("ready"));
  it("shows India VIX, HV, the gap and the rank from the daily history, and says where IV comes from", async () => {
    const n = 130;
    const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
    const iv = Array.from({ length: n }, (_, i) => 10 + i * 0.1); // rising to 22.9, so today is the highest in any range
    const body = { window: 20, dates, close: dates.map((_, i) => 24000 + i), iv, hv: dates.map((_, i) => (i < 19 ? null : 12)), nifty_bars: n, vix_bars: n, days: n,
      iv_source: "India VIX daily close (NSE's 30-day implied volatility of NIFTY options); not the ATM IV of one expiry", method: "m" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IvChartBody /></QueryClientProvider>);
    const cards = await screen.findByTestId("ivchart-cards");
    expect(cards.textContent).toContain("22.90%"); // IV now
    expect(cards.textContent).toContain("12.00%"); // HV 20d
    expect(cards.textContent).toContain("+10.90 pts"); // 22.9 - 12
    expect(screen.getByText("IVR 1Y")).toBeTruthy();
    // 130 days is fewer than the 252 of a 1Y range: no rank is shown, not a rank over a shorter range
    expect(cards.textContent).toContain("—");
    expect(screen.getByTestId("ivchart-reading").textContent).toContain("Not enough history for a 1Y percentile");
    expect(document.body.textContent).toContain("India VIX");
    expect(screen.getAllByRole("img").length).toBe(2);
  });
  it("says so when the history could not be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code: "x", message: "down" } }), { status: 500 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IvChartBody /></QueryClientProvider>);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});
