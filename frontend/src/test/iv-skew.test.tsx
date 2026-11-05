// Volatility Skew page and the multi-expiry IV - Intraday page render what the backend computed. Numbers are formula checks, not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IvIntradayBody } from "../components/IvIntraday";
import { IvSkewBody, skewReading } from "../components/IvSkew";
import { toolById } from "../lib/tools";
import type { IvSeries, IvSkew } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

function mock(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    return hit ? new Response(JSON.stringify(typeof hit[1] === "function" ? (hit[1] as (u: string) => unknown)(url) : hit[1]), { status: 200 }) : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
  return calls;
}
const wrap = (el: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
afterEach(() => vi.unstubAllGlobals());

const skew: IvSkew = {
  status: "ok", expiry: "2026-11-10", at: "2026-11-05T04:30:00Z", age_seconds: 60, spot: 24000, forward: 24010, atm_strike: 24000, atm_iv: 16, days: 5,
  cards: { skew_25d: 4, skew_10d: 6.5, butterfly_25d: 0, slope_per_pct: -2.0571, put_25d_iv: 18, call_25d_iv: 14, term_slope_per_30d: 1.2 },
  smile: [
    { strike: 23900, side: "PE", iv: 17, delta: -0.4 }, { strike: 24000, side: "CE", iv: 16, delta: 0.5 }, { strike: 24100, side: "CE", iv: null, delta: null },
  ],
  term: [
    { expiry: "2026-11-10", days: 5, atm_iv: 16, skew_25d: 4, skew_10d: 6.5, butterfly_25d: 0, slope_per_pct: -2, put_25d_iv: 18, call_25d_iv: 14 },
    { expiry: "2026-11-24", days: 19, atm_iv: 16.56, skew_25d: 3, skew_10d: null, butterfly_25d: 0.2, slope_per_pct: -1, put_25d_iv: 17, call_25d_iv: 14 },
  ],
};

describe("Volatility Skew", () => {
  it("is a ready page tool", () => expect(toolById("volatility-skew")?.page).toBe("ivskew"));
  it("words the skew sign and says when it is missing", () => {
    expect(skewReading(4)).toContain("Puts are priced 4.00 points above calls");
    expect(skewReading(-1.5)).toContain("Calls are priced 1.50 points above puts");
    expect(skewReading(0.2)).toContain("little skew");
    expect(skewReading(null)).toContain("not available");
  });
  it("shows the six measures, the table with a missing IV left missing, and the term view", async () => {
    mock({ "/api/intraday/iv-skew": skew });
    wrap(<IvSkewBody expiry="2026-11-10" />);
    const cards = (await screen.findByTestId("ivskew-cards")).textContent!;
    expect(cards).toContain("16.00%");
    expect(cards).toContain("+4.00 pts"); // 25 delta skew
    expect(cards).toContain("+6.50 pts");
    expect(cards).toContain("−2.06 pts/%");
    expect(cards).toContain("+1.20 pts/30d"); // (16.56 - 16) / (19 - 5) x 30 = 1.2 (hand calculation)
    expect(screen.getByTestId("ivskew-reading").textContent).toContain("Puts are priced 4.00 points above calls");
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    const rows = within(screen.getByTestId("ivskew-table")).getAllByRole("row");
    expect(rows[3]!.textContent).toContain("—"); // 24 100 had no solved IV: missing, not zero
    fireEvent.click(screen.getByRole("tab", { name: "Term" }));
    expect(screen.getByTestId("ivskew-term")).toBeInTheDocument();
  });
  it("says why when nothing is stored", async () => {
    mock({ "/api/intraday/iv-skew": { status: "no stored option-chain sample for this expiry", smile: [], term: [] } });
    wrap(<IvSkewBody expiry="2026-11-10" />);
    expect(await screen.findByTestId("ivskew-empty")).toHaveTextContent("no stored option-chain sample");
  });
});

describe("IV - Intraday with several expiries", () => {
  const mk = (expiry: string, iv: number, days: number): IvSeries => ({
    status: "ok", expiry, session: "2026-11-05", is_today: true, samples_in_session: 2, points_shown: 2, thinned_every: 1, tf_minutes: 5,
    latest_at: "2026-11-05T04:30:00Z", age_seconds: 60, high: iv + 0.5, low: iv, model: "Black-76", rate_assumed: 0.07,
    points: [
      { at: "2026-11-05T04:25:00Z", spot: 24000, forward: 24010, days, atm_iv: iv, straddle: 300, skew: 1, note: null },
      { at: "2026-11-05T04:30:00Z", spot: 24005, forward: 24015, days, atm_iv: iv + 0.5, straddle: 301, skew: 1, note: null },
    ],
  });
  it("asks each chosen expiry for the chosen session and candle, and draws the term structure from their last values", async () => {
    const calls = mock({
      "/api/expiries": { underlying: "NIFTY", as_of: "x", available: ["2026-11-10", "2026-11-24"], weekly: "2026-11-10", monthly: "2026-11-24" },
      "/api/intraday/iv-sessions": { sessions: ["2026-11-04", "2026-11-05"] },
      "/api/intraday/iv-series": (u: string) => (u.includes("2026-11-24") ? mk("2026-11-24", 16.5, 19) : mk("2026-11-10", 16, 5)),
    });
    wrap(<IvIntradayBody expiry="2026-11-10" />);
    expect(await screen.findByTestId("ivintraday-stats")).toHaveTextContent("16.50%"); // latest of the primary expiry (16 + 0.5)
    fireEvent.click(await screen.findByRole("button", { name: "11-24" })); // add the second expiry
    fireEvent.click(screen.getByRole("button", { name: "5m" }));
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "2026-11-04" } });
    await screen.findByRole("img", { name: /At-the-money implied volatility through the session/ });
    await vi.waitFor(() => expect(calls.some((u) => u.includes("expiry=2026-11-24") && u.includes("session=2026-11-04") && u.includes("tf=5"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Term structure" }));
    expect(await screen.findByTestId("ivintraday-term")).toBeInTheDocument();
  });
});
