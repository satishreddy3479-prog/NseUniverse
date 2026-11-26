// What-if on the volatility surface inside the Strategy Builder (BuilderWhatIf): the engine's scenario, presets, risk matrix and payoff for the strategy's option legs, and
// the NIFTY future added on top. Fixtures are real engine output (captured from the risk API on exact synthetic chains).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderWhatIf } from "../components/risk/BuilderWhatIf";
import { futureUnits, gridWithFutures, presetsWithFutures, scenarioWithFutures, type GridResult, type RiskPresets, type ScenarioResult } from "../lib/risk";
import type { Leg } from "../lib/strategy";
import gridPayoff from "./fixtures/risk/grid_payoff.json";
import gridIv from "./fixtures/risk/grid_spot_iv.json";
import gridTime from "./fixtures/risk/grid_spot_time.json";
import presetsFx from "./fixtures/risk/presets.json";
import scenarioFx from "./fixtures/risk/scenario.json";
import statusFx from "./fixtures/risk/status.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: unknown }) => <div role="img" aria-label={ariaLabel} data-option={JSON.stringify(option)} />,
}));

const E1 = "2026-11-03";
const E2 = "2026-11-23";
const LEGS = [
  { expiry: E1, strike: 25500, type: "CE", action: "SELL", lots: 2, entry_price: 140 },
  { expiry: E1, strike: 25500, type: "PE", action: "SELL", lots: 2, entry_price: 130 },
  { expiry: E1, strike: 25800, type: "CE", action: "BUY", lots: 2, entry_price: null },
  { expiry: E1, strike: 25200, type: "PE", action: "BUY", lots: 2, entry_price: null },
  { expiry: E2, strike: 25500, type: "CE", action: "BUY", lots: 1, entry_price: null },
] as never[];

type Over = Partial<Record<string, { status?: number; body: unknown }>>;
let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
function install(over: Over = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const key = url.replace(/\?.*/, "");
    const o = over[key] ?? over[url];
    if (o) return reply(o.body, o.status ?? 200);
    if (key === "/api/risk/status") return reply(statusFx);
    if (key === "/api/risk/scenario") return reply(scenarioFx);
    if (key === "/api/risk/presets") return reply(presetsFx);
    if (key === "/api/risk/grid") return reply(body?.kind === "spot_time" ? gridTime : body?.kind === "payoff" ? gridPayoff : gridIv);
    return reply({ detail: { code: "nf", message: "not found" } }, 404);
  }));
}
function mount(legs = LEGS, futUnits = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><BuilderWhatIf legs={legs} futUnits={futUnits} /></QueryClientProvider>);
}
const optionOf = (label: string | RegExp) => JSON.parse(screen.getByRole("img", { name: label }).getAttribute("data-option") ?? "{}") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("What-if on the surface, in the Strategy Builder", () => {
  it("the scenario result is the engine's: total, volatilities and values per leg, and the entry-price column", async () => {
    install();
    mount();
    expect(await screen.findByTestId("risk-total")).toHaveTextContent("+₹4,848"); // the fixture's 4848.4756
    const t = screen.getByTestId("risk-leg-results");
    const rows = within(t).getAllByRole("row");
    expect(rows).toHaveLength(6); // header and five legs
    expect(rows[1]).toHaveTextContent("11-03 · 25,500 CE · Sell 2");
    expect(rows[1]).toHaveTextContent("−₹14,488"); // first leg's change
    expect(rows[3]).toHaveTextContent("—"); // a leg with no entry price: a dash, not zero
    const body = calls.find((c) => c.url === "/api/risk/scenario")!.body!;
    expect((body.legs as unknown[]).length).toBe(5);
    expect(body.scenario).toMatchObject({ spot_shock: 0, iv_shock: 0, time_elapsed_hours: 0, sticky_rule: "moneyness" });
  });

  it("preset buttons show their P&L and apply their scenario to the controls and to the request", async () => {
    install();
    mount();
    const gap = await screen.findByTestId("risk-preset-gap_down");
    expect(gap).toHaveTextContent("Gap down 2%");
    expect(gap).toHaveTextContent("−₹25,801"); // the fixture
    expect(screen.getByTestId("risk-preset-sd_plus_1")).toHaveTextContent("+₹4,330");
    expect(screen.getByTestId("risk-preset-expiry_crush")).toHaveTextContent("+₹12,499");
    expect(gap).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(gap);
    await waitFor(() => expect(screen.getByTestId("risk-spot")).toHaveValue("-510")); // a slider: its value is text
    expect(screen.getByTestId("risk-spot-value")).toHaveTextContent("−510 pts");
    expect(screen.getByTestId("risk-preset-gap_down")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/risk/scenario" && (c.body!.scenario as { spot_shock: number }).spot_shock === -510)).toBe(true));
    fireEvent.click(screen.getByTestId("risk-reset"));
    await waitFor(() => expect(screen.getByTestId("risk-spot")).toHaveValue("0"));
    fireEvent.change(screen.getByTestId("risk-rule"), { target: { value: "delta" } });
    expect(screen.getByTestId("risk-rule-hint")).toHaveTextContent("function of delta");
    fireEvent.change(screen.getByTestId("risk-rate"), { target: { value: "0.5" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/risk/scenario" && (c.body!.scenario as { rate_shock: number; sticky_rule: string }).rate_shock === 0.005 && (c.body!.scenario as { sticky_rule: string }).sticky_rule === "delta")).toBe(true)); // percentage points become an absolute rate
  });

  it("the scenario values are sliders with a readout and exact step buttons, and a preset beyond the usual range widens the track instead of being cut", async () => {
    install();
    mount();
    const spot = await screen.findByTestId("risk-spot");
    expect(spot).toHaveAttribute("type", "range");
    expect(spot).toHaveAttribute("min", "-1000");
    expect(spot).toHaveAttribute("max", "1000");
    fireEvent.change(spot, { target: { value: "120" } }); // dragged
    await waitFor(() => expect(screen.getByTestId("risk-spot-value")).toHaveTextContent("+120 pts"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/risk/scenario" && (c.body!.scenario as { spot_shock: number }).spot_shock === 120)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Spot move (points): one step up" }));
    expect(screen.getByTestId("risk-spot-value")).toHaveTextContent("+125 pts"); // one step is 5 points
    fireEvent.click(screen.getByRole("button", { name: "Spot move (points): one step down" }));
    fireEvent.click(screen.getByRole("button", { name: "Spot move (points): one step down" }));
    expect(screen.getByTestId("risk-spot-value")).toHaveTextContent("+115 pts");
    // volatility in half points, time never below zero, rate in quarter points
    fireEvent.change(screen.getByTestId("risk-iv"), { target: { value: "-2.5" } });
    expect(screen.getByTestId("risk-iv-value")).toHaveTextContent("−2.5 vol pts");
    expect(screen.getByTestId("risk-hours")).toHaveAttribute("min", "0");
    fireEvent.click(screen.getByRole("button", { name: "Time passing (hours): one step down" }));
    expect(screen.getByTestId("risk-hours-value")).toHaveTextContent("0 h"); // already 0: the button is disabled
    fireEvent.change(screen.getByTestId("risk-rate"), { target: { value: "0.75" } });
    expect(screen.getByTestId("risk-rate-value")).toHaveTextContent("+0.75 pp");
  });

  it("the risk matrix is the grid the engine returned, with the surface version, and can switch to time", async () => {
    install();
    mount();
    const chart = await screen.findByRole("img", { name: /Risk matrix/ });
    const o = optionOf(/Risk matrix/);
    expect(o.series[0].data).toHaveLength(15);
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId("risk-matrix")).toHaveTextContent("Surface v1");
    expect(screen.getByTestId("risk-matrix")).toHaveTextContent("Volatility follows moneyness");
    fireEvent.click(screen.getByTestId("risk-matrix-spot_time"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/risk/grid" && c.body!.kind === "spot_time")).toBe(true));
    await waitFor(() => expect(optionOf(/Risk matrix/).xAxis.data).toEqual(["now", "+24h", "+3.0d"]));
    expect(screen.getByTestId("risk-matrix-spot_time")).toHaveAttribute("aria-pressed", "true");
  });

  it("the payoff chart has today's line and the standard deviation bands from the presets", async () => {
    install();
    mount();
    await screen.findByRole("img", { name: /Payoff of the position/ });
    await waitFor(() => expect(optionOf(/Payoff of the position/).series).toHaveLength(2));
    const o = optionOf(/Payoff of the position/);
    expect(o.series[0].name).toBe("At expiry");
    expect(o.series[0].markArea.data).toHaveLength(3);
    const sd1 = presetsFx.presets.sd_plus_1.scenario.spot_shock;
    expect(o.series[0].markArea.data[2][1].xAxis).toBeCloseTo(gridPayoff.forward! + sd1, 6);
    expect(screen.getByTestId("risk-payoff")).toHaveTextContent("Against the current value, not the entry price");
  });

  it("an expiry with no chain, no fit and an invalid input each get their own message", async () => {
    install({ "/api/risk/scenario": { status: 409, body: { detail: { code: "expiry_unavailable", message: "no chain data (and so no lot size) for the expiry 2026-12-29" } } } });
    mount();
    await waitFor(() => expect(screen.getByTestId("risk-result")).toHaveTextContent("no chain data (and so no lot size) for the expiry 2026-12-29. Pick an expiry that has a chain."));
    vi.unstubAllGlobals();
    install({ "/api/risk/scenario": { status: 422, body: { detail: [{ msg: "Input should be greater than 0" }] } } });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("risk-result").some((e) => e.textContent?.includes("Input should be greater than 0"))).toBe(true));
  });
});

describe("the NIFTY future added to the engine's options-only numbers", () => {
  const fut = (action: "BUY" | "SELL", lots = 1, extra: object = {}) => ({ id: "f", expiry: E1, strike: 0, type: "FUT", action, lots, premium: 25800, premiumSource: "market", ...extra }) as Leg;
  it("units are signed lots times lot size for the open, ticked futures only: a sold lot of 65 is -65 per index point", () => {
    expect(futureUnits([fut("SELL")], 65)).toBe(-65);
    expect(futureUnits([fut("BUY", 2), fut("SELL")], 65)).toBe(65);
    expect(futureUnits([fut("BUY", 1, { exitPrice: 25900 }), fut("BUY", 1, { enabled: false }), { ...fut("BUY"), type: "CE" } as Leg], 65)).toBe(0);
    expect(futureUnits([fut("SELL")], null)).toBe(0);
  });
  it("a grid cell gains units x the row's index shock: -65 x +100 points = -6,500 on top of the engine's value, a missing cell stays missing", () => {
    const g: GridResult = { ...(gridIv.grid as unknown as GridResult), row_axis: [-100, 0, 100], col_axis: [0, 1], pnl: [[10, null], [0, 5], [-20, 8]] };
    const out = gridWithFutures(g, -65);
    expect(out.pnl).toEqual([[10 + 6500, null], [0, 5], [-20 - 6500, 8 - 6500]].map((r, i) => (i === 2 ? [-20 - 6500, 8 - 6500] : r)));
    expect(gridWithFutures(g, 0)).toBe(g);
  });
  it("a scenario result and every preset gain units x the spot shock", () => {
    const r = { ...(scenarioFx.result as unknown as ScenarioResult), scenario: { ...(scenarioFx.result as unknown as ScenarioResult).scenario, spot_shock: 50 }, pnl: 1000, partial_pnl: null };
    const o = scenarioWithFutures(r, 130);
    expect(o.pnl).toBe(1000 + 130 * 50); expect(o.partial_pnl).toBeNull();
    const p = presetsWithFutures(presetsFx as unknown as RiskPresets, 65);
    for (const [k, v] of Object.entries(p.presets)) {
      const src = (presetsFx as unknown as RiskPresets).presets[k]!;
      expect(v.pnl).toBeCloseTo((src.pnl ?? 0) + 65 * src.scenario.spot_shock, 6);
    }
  });
  it("on screen: the note names the future, and a preset shows the engine's value plus the future's (gap down 2 %: engine -25,801 plus -65 x -510 = +7,349)", async () => {
    install();
    mount(LEGS, -65);
    expect(await screen.findByTestId("whatif-futures-note")).toHaveTextContent("−₹65 per index point");
    const gap = await screen.findByTestId("risk-preset-gap_down");
    expect(gap).toHaveTextContent("+₹7,349");
    expect(await screen.findByTestId("risk-total")).toHaveTextContent("−₹4,902"); // the fixture's scenario moves the index +150 points: 4,848 + (-65 x 150)
    const matrix = optionOf(/Risk matrix/);
    expect(matrix.series[0].data).toHaveLength(15);
  });
  it("a strategy with only a future has no option legs to ask the engine about, and says so", async () => {
    install();
    mount([], 65);
    expect(await screen.findByTestId("whatif-futures-note")).toHaveTextContent("+₹65 per index point");
    expect(screen.getByText(/has only a future/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/risk/scenario")).toBe(false);
  });
});
