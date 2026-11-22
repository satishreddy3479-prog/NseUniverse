// The divergence panel: what it says for 3 and 5 minute candles, and that it stays quiet and honest otherwise.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartOiDivergence } from "../components/dashboard/SmartOiDivergence";
import type { SmartOiCandle, SmartOiResult } from "../lib/optionTools";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: { series?: { name?: string; data: unknown[] }[] } }) => (
    <div role="img" aria-label={ariaLabel} data-series={(option.series ?? []).map((s) => `${s.name}:${s.data.length}`).join("|")} />
  ),
}));

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// OI PCR rises 0.02 a candle while volume PCR falls 0.02 a candle: a PCR divergence from the sixth candle on
const res = (tf: number, n = 12): SmartOiResult => ({
  day: "2026-11-20", timeframe: tf, baselineAt: null, gapCandles: 0, skippedSamples: 0, strikeChangeCandles: 0, stalls: [], thinBars: 0, unconfirmedBars: [], proxyMinutes: 0, indicativeMinutes: 0, jumps: [],
  candles: Array.from({ length: n }, (_, i) => ({
    slot: i, label: hhmm(555 + i * tf), spot: { open: 100, high: 100.2, low: 99.8, close: 100 }, spotFromBars: true, spotProxy: false, ceOi: 0, peOi: 0, dPe: 0, dCe: 0, p: 0, bullish: null, span: 1, peDay: 0, ceDay: 0, diffDay: 0,
    pcr: 1 + 0.02 * i, volPcr: 0.9 - 0.02 * i, ceVol: null, peVol: null, ceVolDelta: null, peVolDelta: null, fromPrevClose: false, strikesChanged: false,
  }) as SmartOiCandle),
}) as SmartOiResult;

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 }))));
afterEach(() => vi.unstubAllGlobals());
const mount = (r: SmartOiResult | null, tf: number) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SmartOiDivergence res={r} tf={tf} since="2026-11-20T03:45:00Z" expiry="2026-11-24" listed={[25800]} openAtm={25800} />
  </QueryClientProvider>,
);

describe("Smart OI divergence panel", () => {
  it("on 5-minute candles shows the seven readings, the PCR divergence as active and the others quiet, and marks the price line", async () => {
    mount(res(5), 5);
    const panel = await screen.findByTestId("divergence");
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThanOrEqual(7);
    const pcr = within(panel).getByTestId("div-pcr");
    expect(pcr).toHaveAttribute("data-active", "true");
    expect(pcr).toHaveTextContent("bullish");
    expect(pcr).toHaveTextContent("What is held and what is traded disagree");
    for (const id of ["flow", "conviction", "momentum"]) expect(within(panel).getByTestId(`div-${id}`)).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("div-composite")).toHaveTextContent("Mixed: 1 bullish and 0 bearish divergence active."); // one indicator is not a consensus
    expect(screen.getByTestId("div-grade")).toHaveTextContent("Evidence A");
    expect(screen.getByRole("img", { name: "NIFTY close with the divergence signals marked" }).getAttribute("data-series")).toContain("NIFTY close:12");
    expect(within(panel).getByTestId("div-events").textContent).toContain("PCR divergence");
  });
  it("says why the per-strike and future indicators are silent when their stored series is not there", async () => {
    mount(res(3), 3);
    expect(await screen.findByTestId("div-missing")).toHaveTextContent("writing or buying and zone are silent");
    expect(screen.getByTestId("div-writing")).toHaveTextContent("No stored per-strike series.");
    expect(screen.getByTestId("div-future")).toHaveTextContent("No stored NIFTY future series.");
  });
  it("is off on 1 and 15 minute candles, and waits for enough candles", () => {
    mount(res(1), 1);
    expect(screen.getByTestId("div-off")).toHaveTextContent("3 and 5 minute candles");
    mount(res(5, 3), 5);
    expect(screen.getByTestId("div-wait")).toBeInTheDocument();
  });
  it("carries its limits on the page: indicator not validated, and how to read each one", async () => {
    mount(res(5), 5);
    const panel = await screen.findByTestId("divergence");
    expect(panel).toHaveTextContent("indicator, not validated");
    expect(within(panel).getByTestId("div-notes")).toHaveTextContent("not which one is right");
  });
});
