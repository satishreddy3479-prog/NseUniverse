// The Trend & Regime pages: every indicator is a tool in the Analyse menu and renders what the library computed. Prices are synthetic and say so.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrendRegime } from "../pages/TrendRegime";
import { menuGroups, TOOLS, toolPath } from "../lib/tools";
import { TREND_VIEWS } from "../lib/trendViews";
import type { DailyRegime, IndexBars } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  // each mount gets a number, so a test can tell a rebuilt chart (zoom reset) from a redrawn one
  EChart: ({ ariaLabel }: { ariaLabel: string }) => { const id = useRef(++mounts.n); return <div role="img" aria-label={ariaLabel} data-mount={id.current} />; },
}));
const mounts = vi.hoisted(() => ({ n: 0 }));

const T0 = Date.UTC(2026, 10, 20, 3, 45); // 09:15 IST on a session
// a clean rise of 1 point a minute for 90 minutes: every reading says trend
const rise: IndexBars = {
  day: "2026-11-20", days: ["2026-11-19", "2026-11-20"], note: "",
  bars: Array.from({ length: 90 }, (_, i) => ({ at: new Date(T0 + i * 60_000).toISOString(), o: 25000 + i, h: 25000.5 + i + 0.5, l: 25000 + i - 0.5, c: 25000 + i + 0.5, n: 10 })),
};
const daily: DailyRegime = {
  status: "ok", as_of: "2026-10-28", bars: 4685, from: "2007-09-17", validated: false,
  current: { label: "Unclear", raw: "Unclear", votes: { trend: 1, range: 2, evaluable: 4 }, er: 0.02, adx: 35.7, plus_di: 12.6, minus_di: 26.3, r2: 0.14, slope: 13.4, chop: 61.2 },
  series: { dates: ["2026-10-27", "2026-10-28"], close: [25000, 25100], label: ["Unclear", "Unclear"] },
  study: {
    horizon_days: 10, window_days: 20, permutations: 5000, samples: 463, from: "2007-11-26", to: "2026-10-05",
    groups: { "Trending up": { n: 64, forward_er: 0.35, forward_return_pct: 0.83, forward_rv: 13.7 }, "Range-bound": { n: 71, forward_er: 0.4, forward_return_pct: 0.62, forward_rv: 14.5 } },
    claim: { diff_forward_er: -0.074, p_value: 0.979, validated: false, criterion: "test", thirds: [{ from: "2007-11-26", to: "2014-02-28", n_trending: 29, n_range: 20, diff: -0.119 }] },
    direction: { diff_forward_return_pct: 1.81, p_value: 0.058, information_only: true }, thresholds: {},
  },
};

function mock() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/market/index-bars?day=2026-11-19") ? { ...rise, day: "2026-11-19", bars: rise.bars.slice(0, 40) } : url.startsWith("/api/market/index-bars") ? rise : url.startsWith("/api/intraday/regime-daily") ? daily : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
  }));
}
const page = (view: string) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/trend/${view}`]}><Routes><Route path="trend/:view" element={<TrendRegime />} /></Routes></MemoryRouter>
  </QueryClientProvider>,
);
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("Trend & Regime in the Analyse menu", () => {
  it("is one entry in the menu, and every indicator is a tab of that family opening its own view", () => {
    const g = menuGroups("analyse").find((x) => x.group === "Trend & Regime")!;
    expect(g.tools.map((t) => [t.id, t.label])).toEqual([["market-regime", "Trend & Regime"]]);
    const family = TOOLS.filter((t) => t.menu === "analyse" && t.group === "Trend & Regime");
    expect(family.map((t) => t.id)).toEqual(TREND_VIEWS.map((v) => v.id));
    expect(family.every((t) => t.status === "ready" && toolPath(t) === `/trend/${t.id}`)).toBe(true);
    expect(family.filter((t) => !t.tab).map((t) => t.id)).toEqual(["market-regime"]);
  });
  it("the page has no second row of view buttons: the tabs above the page are the one list", async () => {
    mock();
    page("trend-strength");
    await waitFor(() => expect(screen.getByTestId("trend-trend-strength")).toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: "Trend and regime views" })).toBeNull();
  });
});

describe("Trend & Regime pages", () => {
  it("a clean rise reads Trending up with a full score, the readings table, the session line and the descriptive-only warning", async () => {
    mock();
    page("market-regime");
    await waitFor(() => expect(screen.getByTestId("regime-now")).toBeInTheDocument());
    expect(screen.getByTestId("regime-label")).toHaveTextContent("Trending up");
    expect(screen.getByTestId("regime-gauge")).toHaveAttribute("aria-label", "trend score 100 of 100");
    expect(screen.getByTestId("regime-readings")).toHaveTextContent("Efficiency ratio");
    expect(screen.getByTestId("regime-readings")).toHaveTextContent("1.00");
    // 5-minute bars: the first closes at 25004.5 (minute 4), the last at 25089.5 (minute 89): +85.0 points, a straight line
    expect(screen.getByTestId("regime-session")).toHaveTextContent("+85.0 points");
    expect(screen.getByTestId("regime-session")).toHaveTextContent("mostly one-directional");
    expect(screen.getByTestId("regime-now")).toHaveTextContent("not validated");
    expect(screen.getByTestId("regime-chart")).toBeInTheDocument();
    expect(screen.getByTestId("regime-check")).toBeInTheDocument();
  });

  it("every chart has a key under it saying what its colours and lines mean", async () => {
    mock();
    page("market-regime");
    await waitFor(() => expect(screen.getByTestId("regime-chart")).toBeInTheDocument());
    const key = screen.getByTestId("regime-chart").querySelector("[data-testid=chart-key]")!;
    for (const t of ["Trending down", "Weak uptrend", "Range-bound", "Mixed", "Not shaded", "Dashed brown line", "Beige band", "Blue band", "ADX", "+DI", "−DI"]) expect(key).toHaveTextContent(t);
    expect(key).toHaveTextContent("a clean fall, score 0.65 or more");
  });

  it("the other intraday views render their figures", async () => {
    mock();
    const cases: [string, string][] = [["trend-strength", "Efficiency ratio"], ["chop-variance", "Variance ratio"], ["opening-range", "Breakouts"], ["session-structure", "Crossings of the mean"]];
    for (const [view, text] of cases) {
      const { unmount } = page(view);
      await waitFor(() => expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0));
      unmount();
    }
  });

  it("the opening range counts the first 15 minutes and the rising close breaks out above it", async () => {
    mock();
    page("opening-range");
    await waitFor(() => expect(screen.getByTestId("or-stats")).toBeInTheDocument());
    // the first 15 bars (09:15 - 09:29): low 24999.5 (bar 0: 25000 - 0.5), high 25015 (bar 14: 25000.5 + 14 + 0.5)
    expect(screen.getByTestId("or-stats")).toHaveTextContent("24999.5 – 25015.0");
    expect(screen.getByTestId("or-stats")).toHaveTextContent("above the range");
    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    await waitFor(() => expect(screen.getByTestId("or-stats")).toHaveTextContent("24999.5 – 25030.0"));
  });

  it("the daily regime shows the study's verdict as it came out, not validated", async () => {
    mock();
    page("daily-regime");
    await waitFor(() => expect(screen.getByTestId("daily-verdict")).toBeInTheDocument());
    expect(screen.getByTestId("daily-verdict")).toHaveTextContent("Not validated");
    expect(screen.getByTestId("daily-study")).toHaveTextContent("-0.074");
  });

  it("choosing an earlier session loads that session and stays on it", async () => {
    mock();
    page("market-regime");
    await waitFor(() => expect(screen.getByTestId("regime-now")).toBeInTheDocument());
    expect(screen.getByText(/2026-11-20 · 90 one-minute bars/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Session/ }), { target: { value: "2026-11-19" } });
    await waitFor(() => expect(screen.getByText(/2026-11-19 · 40 one-minute bars/)).toBeInTheDocument());
    expect((screen.getByRole("combobox", { name: /Session/ }) as HTMLSelectElement).value).toBe("2026-11-19"); // it does not snap back to the newest
    fireEvent.change(screen.getByRole("combobox", { name: /Session/ }), { target: { value: "2026-11-20" } });
    await waitFor(() => expect(screen.getByText(/2026-11-20 · 90 one-minute bars/)).toBeInTheDocument());
  });

  it("a new candle length, a new session or Reset zoom rebuilds the charts (the zoom window is kept as bar numbers, so it would otherwise stay on bars 2 to 10), a new bar does not", async () => {
    mock();
    page("trend-strength");
    await waitFor(() => expect(screen.getByTestId("strength-chart")).toBeInTheDocument());
    const mount = () => screen.getByTestId("strength-chart").querySelector("[data-mount]")!.getAttribute("data-mount");
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "3 min" }));
    await waitFor(() => expect(mount()).not.toBe(first));
    const second = mount();
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    await waitFor(() => expect(mount()).not.toBe(second));
    const third = mount();
    fireEvent.click(screen.getByRole("button", { name: "3 min" })); // the same length again changes nothing
    expect(mount()).toBe(third);
  });

  it("says so when no bars are stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ day: null, days: [], bars: [], note: "none" }), { status: 200 })));
    page("market-regime");
    await waitFor(() => expect(screen.getByTestId("trend-empty")).toBeInTheDocument());
  });
});
