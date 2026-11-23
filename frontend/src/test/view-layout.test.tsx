// Save layout and Reset on the IV pages, Gamma and Vega: what a page's controls hold and which graphs are switched off come back; Reset returns the standard view.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutBar } from "../components/LayoutBar";
import { IvIntradayBody } from "../components/IvIntraday";
import { IvSkewBody } from "../components/IvSkew";
import { fits, readSaved, useViewLayout } from "../lib/viewLayout";
import type { IvSeries, IvSkew } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, legendOff, onLegendChange }: { ariaLabel: string; legendOff?: string[]; onLegendChange?: (s: Record<string, boolean>) => void }) => (
    <div role="img" aria-label={ariaLabel} data-legend-off={JSON.stringify(legendOff ?? null)}><button type="button" aria-label={`off CE IV in ${ariaLabel}`} onClick={() => onLegendChange?.({ "CE IV": false, "PE IV": true })} /></div>
  ),
}));

const wrap = (el: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

function Probe({ page = "probe", storedWindow }: { page?: string; storedWindow?: number }) {
  const L = useViewLayout(page);
  const [win, setWin] = L.use("window", 15, storedWindow);
  const [on, setOn] = L.use("on", true);
  const [shown, setShown] = L.use("shown", { a: true, b: false });
  const lg = L.legend("main");
  return (
    <div>
      <span data-testid="state">{JSON.stringify({ win, on, shown, off: lg.legendOff })}</span>
      <button type="button" onClick={() => setWin(30)}>win 30</button>
      <button type="button" onClick={() => setOn((x) => !x)}>toggle on</button>
      <button type="button" onClick={() => setShown((s) => ({ ...s, b: true }))}>show b</button>
      <button type="button" onClick={() => lg.onLegendChange({ "Put volume": false, "Call volume": true })}>legend off</button>
      <LayoutBar layout={L} />
    </div>
  );
}
const state = () => JSON.parse(screen.getByTestId("state").textContent!) as { win: number; on: boolean; shown: { a: boolean; b: boolean }; off: string[] };

describe("the layout hook", () => {
  it("starts on the standard view: nothing to save, nothing to reset", () => {
    render(<Probe />);
    expect(state()).toEqual({ win: 15, on: true, shown: { a: true, b: false }, off: [] });
    expect(screen.getByTestId("layout-save")).toBeDisabled();
    expect(screen.getByTestId("layout-reset")).toBeDisabled();
  });
  it("a change lights Save; saving keeps every choice and the graphs switched off; they come back when the page is opened again", () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("win 30")); fireEvent.click(screen.getByText("toggle on")); fireEvent.click(screen.getByText("show b")); fireEvent.click(screen.getByText("legend off"));
    expect(screen.getByTestId("layout-save")).toHaveTextContent("Save layout ●");
    fireEvent.click(screen.getByTestId("layout-save"));
    expect(screen.getByTestId("layout-save")).toHaveTextContent("Layout saved ✓");
    expect(readSaved("probe")).toEqual({ window: 30, on: false, shown: { a: true, b: true }, "off:main": ["Put volume"] });
    cleanup();
    render(<Probe />);
    expect(state()).toEqual({ win: 30, on: false, shown: { a: true, b: true }, off: ["Put volume"] });
    expect(screen.getByTestId("layout-save")).toHaveTextContent("Layout saved ✓");
  });
  it("Reset puts every choice back to the standard one and forgets the saved layout", () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("win 30")); fireEvent.click(screen.getByTestId("layout-save"));
    fireEvent.click(screen.getByTestId("layout-reset"));
    expect(state()).toEqual({ win: 15, on: true, shown: { a: true, b: false }, off: [] });
    expect(localStorage.getItem("nse.layout.v1.probe")).toBeNull();
    expect(screen.getByTestId("layout-save")).toHaveTextContent("Save layout");
    expect(screen.getByTestId("layout-reset")).toBeDisabled();
  });
  it("a choice that starts somewhere else (the candle size this device already remembers) is shown as it is, counts as a change, and Reset still goes to the standard value", () => {
    render(<Probe storedWindow={5} />);
    expect(state().win).toBe(5);
    expect(screen.getByTestId("layout-save")).toHaveTextContent("Save layout ●"); // 5 is not the standard 15
    fireEvent.click(screen.getByTestId("layout-reset"));
    expect(state().win).toBe(15);
  });
  it("a saved entry that does not fit (another type, a missing field) is ignored and the standard value stands", () => {
    localStorage.setItem("nse.layout.v1.probe", JSON.stringify({ window: "soon", on: 3, shown: { a: true }, "off:main": "x" }));
    render(<Probe />);
    expect(state()).toEqual({ win: 15, on: true, shown: { a: true, b: false }, off: [] });
    localStorage.setItem("nse.layout.v1.probe", "not json");
    expect(readSaved("probe")).toBeNull();
    expect(fits(NaN, 1)).toBe(false);
    expect(fits({ a: 1, b: 2 }, { a: 0 })).toBe(true); // extra fields are harmless, missing ones are not
  });
  it("each page keeps its own layout", () => {
    render(<Probe page="one" />);
    fireEvent.click(screen.getByText("win 30")); fireEvent.click(screen.getByTestId("layout-save"));
    cleanup();
    render(<Probe page="two" />);
    expect(state().win).toBe(15);
  });
});

describe("pages", () => {
  const skew: IvSkew = {
    status: "ok", expiry: "2026-11-10", at: "2026-11-05T04:30:00Z", age_seconds: 60, spot: 24000, forward: 24010, atm_strike: 24000, atm_iv: 16, days: 5,
    cards: { skew_25d: 4, skew_10d: 6.5, butterfly_25d: 0, slope_per_pct: -2, put_25d_iv: 18, call_25d_iv: 14, call_minus_put_25d: null, call_minus_put_10d: null, butterfly_10d: null, put_10d_iv: null, call_10d_iv: null, term_slope_per_30d: null } as never,
    smile: [{ strike: 23900, side: "PE", iv: 17, delta: -0.4 }, { strike: 24000, side: "CE", iv: 16, delta: 0.5 }],
    term: [{ expiry: "2026-11-10", days: 5, atm_iv: 16 }] as never,
  };
  it("Volatility Skew: the view chosen (Table) and the graphs switched off are saved and come back; Reset returns to the smile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(skew), { status: 200 })));
    wrap(<IvSkewBody expiry="2026-11-10" />);
    await screen.findByTestId("ivskew-cards");
    expect(screen.getByTestId("layout-save")).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    fireEvent.click(screen.getByTestId("layout-save"));
    expect(readSaved("iv-skew")).toMatchObject({ view: "Table" });
    cleanup();
    wrap(<IvSkewBody expiry="2026-11-10" />);
    await screen.findByTestId("ivskew-cards");
    expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("ivskew-table")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("layout-reset"));
    expect(screen.getByRole("tab", { name: "Smile" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem("nse.layout.v1.iv-skew")).toBeNull();
  });
  it("IV - Intraday: the candle length and the view are saved, the expiries chosen and the session (a day) are not", async () => {
    const mk = (expiry: string, iv: number): IvSeries => ({
      status: "ok", expiry, session: "2026-11-05", is_today: true, samples_in_session: 2, points_shown: 2, thinned_every: 1, tf_minutes: 5, latest_at: "2026-11-05T04:30:00Z", age_seconds: 60, high: iv + 0.5, low: iv, model: "Black-76", rate_assumed: 0.07,
      points: [{ at: "2026-11-05T04:25:00Z", spot: 24000, forward: 24010, days: 5, atm_iv: iv, straddle: 300, skew: 1, note: null }, { at: "2026-11-05T04:30:00Z", spot: 24005, forward: 24015, days: 5, atm_iv: iv + 0.5, straddle: 301, skew: 1, note: null }],
    });
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      const body = url.startsWith("/api/expiries") ? { underlying: "NIFTY", as_of: "x", available: ["2026-11-10", "2026-11-24"], weekly: "2026-11-10", monthly: "2026-11-24" } : url.startsWith("/api/intraday/iv-sessions") ? { sessions: ["2026-11-04", "2026-11-05"] } : mk("2026-11-10", 16);
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    wrap(<IvIntradayBody expiry="2026-11-10" />);
    await screen.findByTestId("ivintraday-stats");
    fireEvent.click(screen.getByRole("button", { name: "5m" }));
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "2026-11-04" } });
    fireEvent.click(screen.getByTestId("layout-save"));
    expect(readSaved("iv-intraday")).toMatchObject({ tf: 5, view: "intraday" });
    expect(Object.keys(readSaved("iv-intraday")!)).not.toContain("session"); // no day, no expiry list
    cleanup();
    wrap(<IvIntradayBody expiry="2026-11-10" />);
    await screen.findByTestId("ivintraday-stats");
    expect(screen.getByRole("button", { name: "5m" })).toHaveAttribute("aria-pressed", "true");
    expect((screen.getByLabelText("Session") as HTMLSelectElement).value).toBe(""); // the latest session, as always: a saved day would be stale tomorrow
  });
});

