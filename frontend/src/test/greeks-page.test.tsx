// The Greeks and What-If page, rendered against real engine output (fixtures captured from the risk API on exact synthetic chains): the version stamp, the position, presets, the scenario result, the risk matrix and
// payoff, the Greeks dashboard with its limits, the volatility surface, and every empty, error, stale and degraded state.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdvancedGreeks } from "../pages/AdvancedGreeks";
import chainFx from "./fixtures/risk/chain_greeks.json";
import degradedFx from "./fixtures/risk/surface_degraded.json";
import gridPayoff from "./fixtures/risk/grid_payoff.json";
import gridIv from "./fixtures/risk/grid_spot_iv.json";
import gridTime from "./fixtures/risk/grid_spot_time.json";
import portfolioFx from "./fixtures/risk/portfolio.json";
import presetsFx from "./fixtures/risk/presets.json";
import scenarioFx from "./fixtures/risk/scenario.json";
import statusFx from "./fixtures/risk/status.json";
import surfaceFx from "./fixtures/risk/surface.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: unknown }) => <div role="img" aria-label={ariaLabel} data-option={JSON.stringify(option)} />,
}));

const E1 = "2026-11-03";

const builderDoc = { doc: { legs: [{ id: "a", expiry: E1, strike: 25500, type: "CE", action: "SELL", lots: 1, premium: 140, premiumSource: "manual" }, { id: "b", expiry: E1, strike: 25400, type: "PE", action: "BUY", lots: 3, premium: null, premiumSource: null, enabled: false }] }, checking: { live: false, last_check_at: null, error: null } };

type Over = Partial<Record<string, { status?: number; body: unknown }>>;
let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

function install(over: Over = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const key = url.replace(/\?.*/, "");
    const o = over[key] ?? over[url];
    if (o) return reply(o.body, o.status ?? 200);
    if (key === "/api/risk/status") return reply(statusFx);
    if (key === "/api/risk/surface") return reply(surfaceFx);
    if (key === "/api/risk/scenario") return reply(scenarioFx);
    if (key === "/api/risk/presets") return reply(presetsFx);
    if (key === "/api/risk/portfolio") return reply(portfolioFx);
    if (key === "/api/risk/grid") return reply(body?.kind === "spot_time" ? gridTime : body?.kind === "payoff" ? gridPayoff : gridIv);
    if (key === "/api/strategies/running") return reply(builderDoc);
    return reply({ detail: { code: "nf", message: "not found" } }, 404);
  }));
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AdvancedGreeks /></MemoryRouter></QueryClientProvider>);
}
const optionOf = (label: string | RegExp) => JSON.parse(screen.getByRole("img", { name: label }).getAttribute("data-option") ?? "{}") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("Greeks and What-If page", () => {
  it("shows the version and time of the surface everything was valued on, and says the chain is stored", async () => {
    install();
    mount();
    await waitFor(() => expect(screen.getByTestId("risk-stamp-text")).toHaveTextContent("Greeks as of 11:00:00 IST, surface v1"));
    expect(screen.getByTestId("risk-stamp-text")).toHaveAttribute("title", portfolioFx.surface_version_id);
    expect(screen.getByTestId("risk-stamp")).toHaveTextContent("Stored chain");
    expect(await screen.findByTestId("risk-greeks-stamp")).toHaveTextContent("Greeks as of 11:00:00 IST, surface v1");
    expect(screen.getByText(/Read-only: nothing is placed or sent to a broker/)).toBeInTheDocument();
  });

  it("analyses the Strategy Builder's strategy only: no legs editor, the open ticked legs go to the engine and the disabled one stays out", async () => {
    install();
    mount();
    await screen.findByTestId("risk-greeks");
    expect(screen.queryByTestId("risk-add-leg")).toBeNull();
    expect(screen.queryByTestId("risk-leg-row")).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/risk/portfolio")).toBe(true));
    const sent = calls.filter((c) => c.url === "/api/risk/portfolio").map((c) => c.body as { legs: unknown[] });
    expect(sent[0]!.legs).toEqual([{ expiry: E1, strike: 25500, type: "CE", action: "SELL", lots: 1, entry_price: 140 }]);
    expect(screen.getByText(/Strategy Builder/, { selector: "a" })).toBeInTheDocument();
  });

  it("the Greeks dashboard shows rupee Greeks, the beta-weighted delta, expiry buckets, and the limits that are near or over", async () => {
    install();
    mount();
    const net = await screen.findByTestId("risk-net");
    const p = portfolioFx.portfolio;
    expect(within(net).getByTestId("risk-net-delta")).toHaveTextContent("+₹31"); // 31.099 rupees per point
    expect(within(net).getByTestId("risk-net-vega")).toHaveTextContent("+₹338");
    expect(within(net).getByTestId("risk-net-theta_day")).toHaveTextContent("+₹407");
    expect(within(net).getByTestId("risk-net-gamma")).toHaveTextContent(p.net.rupee.gamma.toFixed(4).replace("-", "−")); // four decimals, a true minus
    expect(p.net.rupee.gamma).toBeLessThan(0);
    expect(screen.getByTestId("risk-beta")).toHaveTextContent("beta 1.00, config");
    expect(screen.getAllByTestId("risk-bucket").map((r) => r.textContent)).toEqual([expect.stringContaining("2026-11-03 (front)"), expect.stringContaining("2026-11-23 (next)")]);
    const breaches = screen.getAllByTestId("risk-breach");
    expect(breaches.map((b) => b.getAttribute("data-level"))).toEqual(["breach", "breach", "warn"]); // worst first, as the server sent them
    expect(breaches[0]).toHaveTextContent("Over limit");
    expect(breaches[0]).toHaveTextContent("Leg 2026-11-03 25500 CE · delta");
    expect(breaches[0]).toHaveTextContent("109%");
    expect(breaches[2]).toHaveTextContent("Near limit");
    fireEvent.click(screen.getByTestId("risk-unit-raw"));
    expect(screen.getByTestId("risk-net-delta")).toHaveTextContent(`${p.net.raw.delta!.toFixed(2).replace(".", ".")}`);
    expect(screen.getByTestId("risk-net-theta_day")).toHaveTextContent("₹ per year");
    fireEvent.click(screen.getByTestId("risk-unit-rupee"));
    fireEvent.click(screen.getByTestId("risk-more-greeks"));
    const all = within(screen.getByTestId("risk-all-greeks")).getAllByRole("row");
    expect(all).toHaveLength(16); // header and fifteen Greeks
    expect(screen.getByTestId("risk-all-greeks")).toHaveTextContent("Ultima");
  });

  it("each leg opens to its own Greeks, and the model's volatility and value", async () => {
    install();
    mount();
    const details = await screen.findAllByTestId("risk-leg-details");
    expect(details).toHaveLength(5);
    expect(details[0]).toHaveTextContent("11-03 · 25,500 CE · Sell 2 × 65");
    expect(details[0]).toHaveTextContent(/Θ .*\/day/);
    fireEvent.click(within(details[0]!).getByText(/11-03 · 25,500 CE/));
    expect(within(details[0]!).getByText("Volatility used")).toBeInTheDocument();
    expect(within(details[0]!).getByText("Zomma")).toBeInTheDocument();
  });

  it("has the switch for the card that shows the values when you point at a chart, so a choice made on another page can be undone here", async () => {
    install();
    mount();
    const toggle = await screen.findByTestId("chart-info-toggle");
    expect(toggle).toHaveTextContent("Hide chart info"); // shown by default
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Show chart info");
    expect(localStorage.getItem("nse.charts.hideInfo")).toBe("1");
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Hide chart info");
    expect(localStorage.getItem("nse.charts.hideInfo")).toBe("0");
  });

  it("the volatility surface: an expiry at a time, the fit quality, the arbitrage checks, and charts", async () => {
    install();
    mount();
    const viewer = await screen.findByTestId("risk-surface");
    expect(viewer).toHaveTextContent("stored chain, surface v1");
    expect(within(viewer).getByTestId("risk-counts")).toHaveTextContent(/\d+ \/ \d+ \/ \d+/);
    expect(within(viewer).getByTestId("risk-arb")).toHaveTextContent("butterfly ok, calendar ok");
    expect(within(viewer).getByTestId("risk-expiry-2026-11-03")).toHaveAttribute("aria-selected", "true");
    expect(optionOf(/Implied volatility smile for 2026-11-03/).series[0].name).toBe("Fitted smile");
    fireEvent.click(within(viewer).getByTestId("risk-expiry-2026-11-23"));
    await screen.findByRole("img", { name: /Implied volatility smile for 2026-11-23/ });
    expect(within(viewer).getByTestId("risk-expiry-2026-11-23")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("risk-degraded")).toBeNull();
  });
});

describe("empty, error, stale and degraded states", () => {
  it("with an empty Builder it says so and calls no scenario or portfolio endpoint", async () => {
    install({ "/api/strategies/running": { body: { doc: null, checking: { live: false, last_check_at: null, error: null } } } });
    mount();
    expect(await screen.findByTestId("adv-empty")).toHaveTextContent("The Strategy Builder has no open legs");
    expect(calls.some((c) => c.url === "/api/risk/portfolio" || c.url === "/api/risk/scenario")).toBe(false);
  });

  it("no stored chain yet: every panel says why in plain words, not a blank", async () => {
    install({
      "/api/risk/surface": { status: 503, body: { detail: { code: "no_surface", message: "no stored option chain" } } },
      "/api/risk/scenario": { status: 503, body: { detail: { code: "no_surface", message: "no stored option chain" } } },
      "/api/risk/portfolio": { status: 503, body: { detail: { code: "no_surface", message: "no stored option chain" } } },
      "/api/risk/grid": { status: 503, body: { detail: { code: "no_surface", message: "no stored option chain" } } },
      "/api/risk/presets": { status: 503, body: { detail: { code: "no_surface", message: "no stored option chain" } } },
    });
    mount();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("risk-greeks")).toHaveTextContent("No stored option chain is available yet");
    expect(screen.getByTestId("risk-stamp-text")).toHaveTextContent("No surface yet");
  });

  it("a stale stored chain is flagged on the stamp and in the surface", async () => {
    const stale = { ...surfaceFx, stale: true, data: surfaceFx.data.map((d) => ({ ...d, stale: true, age_s: 14400 })) };
    install({ "/api/risk/surface": { body: stale }, "/api/risk/portfolio": { body: { ...portfolioFx, stale: true } } });
    mount();
    expect(await screen.findByTestId("risk-surface-stale")).toHaveTextContent("240 minutes old");
    await waitFor(() => expect(screen.getByTestId("risk-stamp")).toHaveTextContent("stale"));
  });

  it("a degraded expiry is announced on top and in the surface, with the reason, and the engine's own message about the fit", async () => {
    install({ "/api/risk/surface": { body: degradedFx } });
    mount();
    expect(await screen.findByTestId("risk-degraded-banner")).toHaveTextContent("Model degraded for 2026-11-03: only 3 usable points (need 7)");
    const viewer = await screen.findByTestId("risk-surface");
    expect(within(viewer).getByTestId("risk-degraded")).toHaveTextContent("No smile could be fitted");
    expect(within(viewer).getByTestId("risk-expiry-2026-11-03")).toHaveTextContent("⚠");
    expect(within(viewer).getByTestId("risk-problems")).toHaveTextContent(/quote.* not used in the fit/);
  });

  it("an incomplete position says its totals are unavailable and shows the legs that could be valued", async () => {
    const p = JSON.parse(JSON.stringify(portfolioFx));
    p.portfolio.complete = false;
    p.portfolio.warnings = ["leg 2 (2026-12-29 25500 CE): expiry not on the surface"];
    p.portfolio.legs[1].status = "expiry not on the surface";
    install({ "/api/risk/portfolio": { body: p } });
    mount();
    expect(await screen.findByTestId("risk-incomplete")).toHaveTextContent("some legs could not be valued");
    expect(screen.getAllByTestId("risk-leg-details")[1]).toHaveTextContent("expiry not on the surface");
  });

  it("the engine switched off, and a configuration error, are explained instead of showing empty panels", async () => {
    install({ "/api/risk/status": { status: 404, body: { detail: { code: "disabled", message: "off" } } } });
    mount();
    expect(await screen.findByTestId("risk-disabled")).toHaveTextContent("turned off on this server");
    expect(screen.queryByTestId("risk-legs")).toBeNull();
    vi.unstubAllGlobals();
    install({ "/api/risk/status": { body: { ...statusFx, config_error: "GREEKS_LIMITS_JSON is not valid: unknown limit metrics: ['dellta']" } } });
    mount();
    const alerts = await screen.findAllByTestId("risk-config-error");
    expect(alerts[0]).toHaveTextContent("dellta");
  });

  it("chain Greeks fixture has the shape the API promises (guards the fixtures themselves)", () => {
    const row = chainFx.rows[3]!;
    expect(chainFx.rows).toHaveLength(7);
    expect(row.call.unit.delta - row.put.unit.delta).toBeCloseTo(Math.exp(-0.06 * chainFx.t_years), 6);
    expect(Object.keys(row.call.rupee_per_long_lot)).toContain("theta_day");
  });
});
