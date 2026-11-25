// Save layout and Reset on the Smart OI widget: the view (candle length, strikes, lower panels, graphs switched off) is kept in this browser and comes back; Reset returns to the standard view.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { DEFAULT_LAYOUT, LAYOUT_KEY, mergeOff, mergeOn, parseLayout, sameLayout, type SmartOiLayout } from "../lib/smartOiLayout";
import { liveStore } from "../lib/liveStore";
import { bigChain, expiries, status } from "./fixtures";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, legendOff, legendOn, onLegendChange }: { ariaLabel: string; legendOff?: string[]; legendOn?: string[]; onLegendChange?: (s: Record<string, boolean>, d?: Record<string, boolean>) => void }) => (
    <div role="img" aria-label={ariaLabel} data-legend-off={JSON.stringify(legendOff ?? null)} data-legend-on={JSON.stringify(legendOn ?? null)}>
      <button type="button" aria-label={`switch Put volume off in ${ariaLabel}`} onClick={() => onLegendChange?.({ "Put volume": false, "Call volume": true })} />
      <button type="button" aria-label={`switch the per-candle bars on in ${ariaLabel}`} onClick={() => onLegendChange?.({ "Put volume": false, "Call volume": false, "PE − CE per candle (right)": true }, { "Put volume": true, "Call volume": true, "PE − CE per candle (right)": false })} />
    </div>
  ),
}));
class RO { observe() {} unobserve() {} disconnect() {} }

const times = Array.from({ length: 12 }, (_, i) => new Date(Date.parse("2026-10-28T03:45:00Z") + i * 60_000 * 3).toISOString());
const series = { underlying: "NIFTY", expiry: "2026-11-03", strikes: [24000, 24050, 24100], atm_strike: 24050, times, spot: times.map((_, i) => 24040 + i), ce_oi: times.map((_, i) => 3000 + i * 40), pe_oi: times.map((_, i) => 3300 + i * 90),
  ce_change: times.map(() => 100), pe_change: times.map(() => 200), pcr: times.map(() => 1.1), ce_strikes_used: times.map(() => 3), pe_strikes_used: times.map(() => 3), ce_volume: times.map((_, i) => 100 + i * 10), pe_volume: times.map((_, i) => 100 + i * 12), stride: 1, warnings: [], definitions: {} };
const obs = { snapshot_id: "s1", retrieved_at: times[0], session_id: "x", underlying_ltp: 24050, underlying_prev_close: 24100, atm_strike: 24050, atm_call_ltp: 100, atm_put_ltp: 100, straddle: 200, total_ce_premium: 700, total_pe_premium: 700, total_ce_oi: 7000, total_pe_oi: 7000, total_ce_volume: 70, total_pe_volume: 70, strikes_in_universe: 7, missing_ltp: 0, same_as_previous: false };

function mockApi() {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [], "/api/option-chain": bigChain(),
    "/api/history/observations": { underlying: "NIFTY", expiry: "2026-11-03", strikes_each_side: 10, observations: [obs], distinct_observations: 1, definitions: {}, note: "" }, "/api/history/oi-series": series,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 }) : new Response(JSON.stringify(hit), { status: 200 });
  }));
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/tools/smart-oi"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
beforeEach(() => { vi.stubGlobal("ResizeObserver", RO); localStorage.clear(); liveStore.reset(); mockApi(); });
afterEach(() => vi.unstubAllGlobals());

describe("the saved layout, as data", () => {
  const L: SmartOiLayout = { tf: 5, strikes: 10, lower: "volume", lowerLeft: "volume", off: { main: ["Put volume"], day: [], ratio: ["PCR"] }, on: { main: [], day: [], ratio: ["PE − CE per candle (right)"] } };
  it("is read back field by field, and anything unusable falls back to the standard value", () => {
    expect(parseLayout(JSON.stringify(L))).toEqual(L);
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout("not json")).toBeNull();
    expect(parseLayout(JSON.stringify({ tf: 7, strikes: -3, lower: "x", lowerLeft: 5, off: { main: ["a", 3, ""], day: "no" } }))).toEqual({ ...DEFAULT_LAYOUT, off: { main: ["a"], day: [], ratio: [] } }); // a bad field is the standard one; only text entries survive in a list
  });
  it("a layout saved before graphs could be switched on is read back with none switched on", () => {
    const old = { tf: 5, strikes: 10, lower: "volume", lowerLeft: "volume", off: { main: ["Put volume"], day: [], ratio: ["PCR"] } };
    expect(parseLayout(JSON.stringify(old))).toEqual({ ...old, on: { main: [], day: [], ratio: [] } });
  });
  it("a graph that is off by default and was switched on is remembered as ON (the saved view used to lose it and show a blank chart)", () => {
    const defaults = { "Put volume": true, "Call volume": true, "PE − CE per candle (right)": false };
    expect(mergeOn([], { "Put volume": false, "Call volume": false, "PE − CE per candle (right)": true }, defaults)).toEqual(["PE − CE per candle (right)"]);
    expect(mergeOn(["PE − CE per candle (right)"], { "Put volume": true, "Call volume": true, "PE − CE per candle (right)": false }, defaults)).toEqual([]); // switched off again
    expect(mergeOn([], { "Put volume": true, "Call volume": true, "PE − CE per candle (right)": false }, defaults)).toEqual([]); // a default-on graph is never listed
    expect(mergeOn(["Other mode graph"], { "Put volume": true }, defaults)).toEqual(["Other mode graph"]); // an entry this legend does not have keeps what it had
    expect(mergeOn([], { a: true }, {})).toEqual([]); // no defaults known: nothing is claimed
  });
  it("two layouts are the same view whatever the order of the graphs switched off", () => {
    expect(sameLayout({ ...L, off: { main: ["a", "b"], day: [], ratio: [] } }, { ...L, off: { main: ["b", "a"], day: [], ratio: [] } })).toBe(true);
    expect(sameLayout(L, { ...L, tf: 3 })).toBe(false);
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, off: { ...DEFAULT_LAYOUT.off, day: ["x"] } })).toBe(false);
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, on: { ...DEFAULT_LAYOUT.on, ratio: ["x"] } })).toBe(false); // a graph switched on is a different view
  });
  it("a legend change keeps the graphs that are off in the other mode: Put volume off while the signals show stays off", () => {
    expect(mergeOff(["Put volume"], { "NIFTY close": true, bullish: false })).toEqual(["Put volume", "bullish"]);
    expect(mergeOff(["Put volume", "bullish"], { "NIFTY close": true, bullish: true })).toEqual(["Put volume"]); // bullish switched on again
    expect(mergeOff([], { "Put volume": false, "Call volume": true })).toEqual(["Put volume"]);
  });
});

describe("the Smart OI widget", () => {
  const box = async () => within(await screen.findByRole("region", { name: "Smart OI: change per candle" }));
  it("starts on the standard view: nothing to save, nothing to reset", async () => {
    mount();
    const w = await box();
    expect(await w.findByTestId("smart-oi-save-layout")).toHaveTextContent("Save layout");
    expect(w.getByTestId("smart-oi-save-layout")).toBeDisabled();
    expect(w.getByTestId("smart-oi-reset-layout")).toBeDisabled();
    expect(w.getByRole("button", { name: "3 min" })).toHaveAttribute("aria-pressed", "true");
  });
  it("a changed candle length lights up Save layout; saving keeps it, and it is still there after the page is opened again", async () => {
    mount();
    let w = await box();
    await userEvent.click(await w.findByRole("button", { name: "5 min" }));
    expect(w.getByTestId("smart-oi-save-layout")).toHaveTextContent("Save layout ●");
    await userEvent.click(w.getByTestId("smart-oi-save-layout"));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({ tf: 5, strikes: "all" });
    expect(w.getByTestId("smart-oi-save-layout")).toHaveTextContent("Layout saved ✓");
    cleanup();
    mount();
    w = await box();
    expect(await w.findByRole("button", { name: "5 min" })).toHaveAttribute("aria-pressed", "true");
    expect(w.getByRole("button", { name: "3 min" })).toHaveAttribute("aria-pressed", "false");
    expect(w.getByTestId("smart-oi-save-layout")).toHaveTextContent("Layout saved ✓");
  });
  it("a graph switched off in a chart, and the lower panel chosen, are saved and come back; Reset puts the standard view back and forgets the saved one", async () => {
    mount();
    let w = await box();
    await userEvent.click(await w.findByRole("button", { name: "Volume" })); // the lower panel of the main chart: volume instead of the signals
    const main = await w.findByRole("img", { name: /NIFTY candles, Smart OI candles and option volume/ });
    await userEvent.click(within(main).getByRole("button", { name: /switch Put volume off/ }));
    expect(main.getAttribute("data-legend-off")).toBe(JSON.stringify(["Put volume"]));
    await userEvent.click(w.getByTestId("smart-oi-save-layout"));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toMatchObject({ lowerLeft: "volume", off: { main: ["Put volume"] } });
    cleanup();
    mount();
    w = await box();
    const again = await w.findByRole("img", { name: /NIFTY candles, Smart OI candles and option volume/ });
    expect(again.getAttribute("data-legend-off")).toBe(JSON.stringify(["Put volume"]));
    expect(within(w.getByTestId("smart-oi-lower-left")).getByRole("button", { name: "Volume" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(w.getByTestId("smart-oi-reset-layout"));
    await waitFor(() => expect(localStorage.getItem(LAYOUT_KEY)).toBeNull());
    expect(w.getByRole("button", { name: "3 min" })).toHaveAttribute("aria-pressed", "true");
    expect(w.getByTestId("smart-oi-save-layout")).toHaveTextContent("Save layout");
    expect((await w.findByRole("img", { name: /NIFTY candles, Smart OI candles and the divergence signals/ })).getAttribute("data-legend-off")).toBe(JSON.stringify([]));
  });
});

describe("a saved view with a graph switched on that the chart starts without", () => {
  const box = async () => within(await screen.findByRole("region", { name: "Smart OI: change per candle" }));
  const ratio = () => screen.findByRole("img", { name: /Put and call volume today/ });
  it("is handed to the chart again after the page is opened again, together with the graphs that were switched off", async () => {
    const saved: SmartOiLayout = { ...DEFAULT_LAYOUT, lower: "volume", off: { main: [], day: [], ratio: ["Put volume", "Call volume", "PE − CE volume (day, right)"] }, on: { main: [], day: [], ratio: ["PE − CE per candle (right)"] } };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved));
    mount();
    await box();
    expect(JSON.parse((await ratio()).getAttribute("data-legend-on")!)).toEqual(["PE − CE per candle (right)"]);
    expect(JSON.parse((await ratio()).getAttribute("data-legend-off")!)).toEqual(["Put volume", "Call volume", "PE − CE volume (day, right)"]);
  });
  it("switching the per-candle bars on and saving keeps them: the layout carries them in `on`", async () => {
    mount();
    let w = await box();
    await userEvent.click(await w.findByRole("button", { name: "PE, CE & PE − CE volume" }));
    await userEvent.click(await w.findByRole("button", { name: /switch the per-candle bars on in Put and call volume today/ }));
    await userEvent.click(w.getByTestId("smart-oi-save-layout"));
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY)!) as SmartOiLayout;
    expect(stored.on.ratio).toEqual(["PE − CE per candle (right)"]);
    expect(stored.off.ratio).toEqual(expect.arrayContaining(["Put volume", "Call volume"]));
    cleanup();
    mount();
    w = await box();
    expect(JSON.parse((await ratio()).getAttribute("data-legend-on")!)).toEqual(["PE − CE per candle (right)"]);
  });
});

import { legendToShow } from "../lib/legendHeal";
describe("a saved view never opens a chart with every graph off (the layout saved before graphs could be switched on)", () => {
  const names = ["Put volume (day)", "Call volume (day)", "PE − CE volume (day, right)", "PE − CE per candle (right)"];
  const defaults = { "Put volume (day)": true, "Call volume (day)": true, "PE − CE volume (day, right)": true, "PE − CE per candle (right)": false };
  it("the exact case: three graphs saved as off, the fourth starts off and was never saved as on -> the fourth is shown", () => {
    expect(legendToShow(names, defaults, ["Put volume (day)", "Call volume (day)", "PE − CE volume (day, right)"])).toEqual(["PE − CE per candle (right)"]);
  });
  it("leaves a chart alone when something is already shown, or a graph the view switched on is in the list", () => {
    expect(legendToShow(names, defaults, ["Put volume (day)"])).toEqual([]); // two default-on graphs are still shown
    expect(legendToShow(names, defaults, ["Put volume (day)", "Call volume (day)", "PE − CE volume (day, right)"], ["PE − CE per candle (right)"])).toEqual([]);
    expect(legendToShow(names, defaults, [])).toEqual([]);
  });
  it("shows everything when the view switched every graph off, and nothing when the chart has no legend", () => {
    expect(legendToShow(names, defaults, names)).toEqual(names);
    expect(legendToShow([], {}, [])).toEqual([]);
  });
});
