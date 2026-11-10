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
    const body = { window: 20, dates, close: dates.map((_, i) => 24000 + i), iv, hv: dates.map((_, i) => (i < 19 ? null : 12)), rv: dates.map((_, i) => (i < 19 ? null : 13.5)), nifty_bars: n, vix_bars: n, days: n,
      iv_source: "India VIX daily close (NSE's 30-day implied volatility of NIFTY options); not the ATM IV of one expiry", method: "m" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IvChartBody /></QueryClientProvider>);
    const cards = await screen.findByTestId("ivchart-cards");
    expect(cards.textContent).toContain("22.90%"); // IV now
    expect(cards.textContent).toContain("12.00%"); // HV 20d
    expect(cards.textContent).toContain("+10.90 pts"); // 22.9 - 12
    expect(cards.textContent).toContain("13.50%"); // RV 20d (range)
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

describe("date axis", () => {
  it("writes days readably and always labels the newest day", async () => {
    const { fmtDay, labelEvery } = await import("../lib/ivChart");
    expect(fmtDay("2026-11-05")).toBe("5 Nov 26");
    expect(fmtDay("2026-01-30")).toBe("30 Jan 26");
    const show = labelEvery(100, 7); // step 15, counted back from the last index (99)
    expect(show(99)).toBe(true);
    expect(show(84)).toBe(true);
    expect(show(98)).toBe(false);
    expect([...Array(100).keys()].filter(show).length).toBeLessThanOrEqual(8);
    expect(labelEvery(1)(0)).toBe(true);
  });
});

describe("provisional latest day", () => {
  it("reaches the latest session with HV, RV and NIFTY, leaves India VIX empty, and says so", async () => {
    const dates = ["2026-11-03", "2026-11-04", "2026-11-05"];
    const body = { window: 21, dates, close: [23810.85, 23960.6, 24536.6], iv: [15.72, 15.19, null], hv: [16, 16.01, 16.83], rv: [17, 16.1, 17.75], nifty_bars: 2, vix_bars: 2, days: 3,
      provisional: { date: "2026-11-05", close: 24536.6, note: "NIFTY close from our own stored index feed; India VIX for this day is not published yet and is left empty" },
      iv_source: "India VIX daily close", method: "m" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IvChartBody /></QueryClientProvider>);
    const cards = (await screen.findByTestId("ivchart-cards")).textContent!;
    expect(cards).toContain("15.19%"); // India VIX of the last day that has one (4 Nov), dated in its label
    expect(cards).toContain("4 Nov 26");
    expect(cards).toContain("16.83%"); // HV of the provisional 5 Nov
    expect(cards).toContain("17.75%");
    expect(cards).toContain("−0.82 pts"); // IV − HV is taken on 4 Nov for both: 15.19 − 16.01
  });
});

describe("worked example under the IV chart", () => {
  it("reproduces the rank and percentile by hand from the same window", async () => {
    const { rankAt, rankExample } = await import("../lib/ivChart");
    const vals = Array.from({ length: 63 }, (_, i) => 10 + (i % 11)); // 10..20, repeating
    vals[62] = 15;
    const r = rankAt(vals, 62, 63);
    // low 10, high 20: IVR = (15 - 10) / (20 - 10) x 100 = 50
    const ex = rankExample(15, r, "3M", 21, 12.5, 11.75);
    expect(ex[0]).toContain("= (15.00 − 10.00) / (20.00 − 10.00) × 100 = 50.0");
    expect(ex[1]).toContain(`out of 63 days × 100 = ${r.ivp!.toFixed(1)}`);
    expect(ex[2]).toContain("IV − HV 1M = 15.00 − 12.50 = 2.50 points");
    expect(ex[3]).toContain("IV − RV 1M = 15.00 − 11.75 = 3.25 points");
  });
});
