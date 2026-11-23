// The divergence panel: what it says for 3 and 5 minute candles, and that it stays quiet and honest otherwise.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartOiDivergence, useDivergence } from "../components/dashboard/SmartOiDivergence";
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
function Host({ r, tf }: { r: SmartOiResult | null; tf: number }) {
  const d = useDivergence(r, tf, "2026-11-20T03:45:00Z", "2026-11-24", [25800], 25800);
  return <SmartOiDivergence res={r} tf={tf} d={d} />;
}
const mount = (r: SmartOiResult | null, tf: number) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Host r={r} tf={tf} />
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
    expect(within(panel).getByTestId("div-events").textContent).toContain("PCR divergence");
    const card = within(panel).getByTestId("div-scorecard"); // how the day's signals fared, with the one bullish signal counted
    expect(within(card).getByTestId("score-bullish")).toHaveTextContent(/Bullish divergences\s*1/);
    expect(within(card).getByTestId("score-bearish")).toHaveTextContent(/Bearish divergences\s*0/);
    expect(within(card).getByTestId("score-note")).toHaveTextContent("proves nothing");
  });
  it("says why the per-strike and future indicators are silent when their stored series is not there", async () => {
    mount(res(3), 3);
    expect(await screen.findByTestId("div-missing")).toHaveTextContent("writing or buying and zone are silent");
    expect(screen.getByTestId("div-writing")).toHaveTextContent("No stored per-strike series.");
    expect(screen.getByTestId("div-future")).toHaveTextContent("No stored NIFTY future series.");
  });
  it("is off on 15 minute candles, runs on 1 minute ones, and waits for enough candles", () => {
    mount(res(15), 15);
    expect(screen.getByTestId("div-off")).toHaveTextContent("1, 3 and 5 minute candles");
    cleanup();
    mount(res(1, 40), 1);
    expect(screen.getByTestId("divergence")).toHaveTextContent("1-minute candles");
    cleanup();
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
