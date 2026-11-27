// The strike view of the Premium Change tool. The server's answer below is a hand-built sample whose parts add up:
//   25600 straddle 381.0 -> 301.4, real change -79.6 = theta -9.1 + vega -43.0 + delta -38.4 + gamma +11.5 + vanna/volga -0.6 + other 0.0
//   sentence: volatility = vega + cross = -43.6, NIFTY moving = delta + gamma = -26.9;  rupees = 79.6 x 65 = 5,174
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { place } from "../lib/positionMonitor";
import { bigChain, expiries, status } from "./fixtures";
import { driverText, hhmm, readout, rupee, sg, type StrikePremiumData } from "../lib/strikePremium";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")} data-points={(o.series ?? []).map((s) => s.data.length).join(",")} />;
  },
}));

const parts = { theta: -9.1, vega: -43.0, delta: -38.4, gamma: 11.5, cross: -0.6, other: 0.0, actual: -79.6 };
const side = (price: number, change: number, driver: { name: "time" | "volatility" | "NIFTY" | "other"; value: number }) => ({ price, change, parts: { ...parts, actual: change }, driver, complete: true });
const sample: StrikePremiumData = {
  status: "ok", session: "2026-11-27", expiry: "2026-12-01", strike: 25600, strike_now: 25600, strikes: [25500, 25550, 25600, 25650, 25700], mode: "fixed", contract: "straddle", window: 30, bucket: 5, lot_size: 65,
  rate_assumed: 0.07, note: "Last traded prices; Black-76 with the forward from put-call parity and the app's assumed rate.", skipped_steps: 0,
  series: { t: ["2026-11-27T03:50:00+00:00", "2026-11-27T07:00:00+00:00", "2026-11-27T10:09:00+00:00"], spot: [25885, 25700, 25590], price: [381.0, 340.2, 301.4], cum: { theta: [0, -4.5, -9.1], vega: [0, -20, -43], delta: [0, -20, -38.4], gamma: [0, 6, 11.5], cross: [0, -0.3, -0.6], other: [0, 0, 0], actual: [0, -38.8, -79.6] } },
  bars: [{ t: "2026-11-27T03:55:00+00:00", ...parts }, { t: "2026-11-27T04:00:00+00:00", ...parts }],
  summary: { from: "2026-11-27T03:50:00+00:00", to: "2026-11-27T10:09:00+00:00", minutes: 379, steps: 379, price_start: 381.0, price_end: 301.4, parts, real_change: -79.6, driver: { name: "volatility", value: -43.6 }, nifty_start: 25885, nifty_end: 25590 },
  ladder: [
    { strike: 25550, atm: false, call: side(176.2, 17.6, { name: "NIFTY", value: 16.4 }), put: side(124.5, -13.8, { name: "NIFTY", value: -13.0 }) },
    { strike: 25600, atm: true, call: side(143.5, 14.9, { name: "NIFTY", value: 13.5 }), put: side(157.7, -9.8, { name: "NIFTY", value: -11.3 }) },
    { strike: 25700, atm: false, call: side(88.3, 8.8, { name: "volatility", value: 4.1 }), put: side(233.8, -3.2, { name: "volatility", value: 4.0 }) },
  ],
  greeks_now: { strike: 25600, delta: 0.01, gamma: 0.0021, theta_day: -6.3, vega_pt: 0.18, iv_pct: 13.9 },
};

let calls: string[];
let answer: (url: string) => unknown;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  answer = () => sample;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    if (path === "/api/intelligence/strike-premium") calls.push(url);
    const routes: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [], "/api/option-chain": bigChain(), "/api/intelligence/strike-premium": answer(url) };
    const hit = path.startsWith("/api/snapshots/") ? bigChain() : routes[path];
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/tools/premium-change"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);

describe("Premium Change: strike view", () => {
  it("opens on the strike view and reads the contract in a sentence whose parts add up, with a tile for each part", async () => {
    mount();
    const readoutEl = await screen.findByTestId("sp-readout");
    expect(readoutEl.textContent).toBe("The 25600 straddle, 09:20 to 15:39: its price fell from 381.0 to 301.4 (−79.6 points, −₹5,174 per lot). Time −9.1, volatility −43.6, NIFTY moving −26.9, other +0.0.");
    const tiles = screen.getByTestId("sp-tiles");
    expect(within(tiles).getByTestId("sp-tile-theta")).toHaveTextContent("−9.1"); expect(within(tiles).getByTestId("sp-tile-theta")).toHaveTextContent("−₹592 per lot"); // 9.1 x 65 = 591.5
    expect(within(tiles).getByTestId("sp-tile-vega")).toHaveTextContent("−43.0"); expect(within(tiles).getByTestId("sp-tile-vega")).toHaveTextContent("−₹2,795 per lot");
    expect(within(tiles).getByTestId("sp-tile-delta")).toHaveTextContent("−38.4"); expect(within(tiles).getByTestId("sp-tile-delta")).toHaveTextContent("−₹2,496 per lot");
    expect(within(tiles).getByTestId("sp-tile-gamma")).toHaveTextContent("+11.5"); expect(within(tiles).getByTestId("sp-tile-gamma")).toHaveTextContent("+₹748 per lot");
    expect(within(tiles).getByTestId("sp-tile-cross")).toHaveTextContent("−0.6"); expect(within(tiles).getByTestId("sp-tile-other")).toHaveTextContent("+0.0");
    const sum = (["theta", "vega", "delta", "gamma", "cross", "other"] as const).reduce((a, k) => a + parts[k], 0);
    expect(Math.round(sum * 10) / 10).toBe(-79.6); // the sample adds up
    expect(calls[0]).toContain("/api/intelligence/strike-premium?expiry=2026-11-03"); // the expiry the tool page is on
    expect(calls[0]).toContain("mode=fixed"); expect(calls[0]).toContain("contract=straddle"); expect(calls[0]).toContain("window=30"); expect(calls[0]).not.toContain("strike=");
  });

  it("draws the price, the cumulative parts and the bucket bars, and says what each shows", async () => {
    mount();
    await screen.findByTestId("sp-readout");
    expect(screen.getByRole("img", { name: "Price of the followed contract and NIFTY" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Parts added up from the first sample, and the real change" }).getAttribute("data-series")).toBe("Time (theta)|Volatility (vega)|NIFTY (delta)|Convexity (gamma)|Vanna and volga|Other|Real change (all parts)");
    expect(screen.getByRole("img", { name: "Parts of every 5-minute bucket" }).getAttribute("data-points")).toBe("2,2,2,2,2,2");
    expect(screen.getByText(/The parts add up to the dashed line/)).toBeInTheDocument();
  });

  it("lists every strike with each contract's change and the part that drove it, and shows the Greeks now", async () => {
    mount();
    const table = await screen.findByTestId("sp-ladder");
    const atm = within(table).getByTestId("sp-row-25600");
    expect(atm).toHaveTextContent("ATM"); expect(atm).toHaveTextContent("143.5 · +14.9"); expect(atm).toHaveTextContent("NIFTY +13.5"); expect(atm).toHaveTextContent("157.7 · −9.8"); expect(atm).toHaveAttribute("aria-selected", "true");
    expect(within(table).getByTestId("sp-row-25700")).toHaveTextContent("volatility +4.1");
    expect(screen.getByTestId("sp-greeks")).toHaveTextContent("delta +0.01"); expect(screen.getByTestId("sp-greeks")).toHaveTextContent("gamma 0.0021");
    expect(screen.getByTestId("sp-greeks")).toHaveTextContent("theta −₹410/day"); // -6.3 x 65 = -409.5
    expect(screen.getByTestId("sp-greeks")).toHaveTextContent("vega 12 rupees per vol point"); // 0.18 x 65 = 11.7
    expect(screen.getByTestId("sp-greeks")).toHaveTextContent("IV 13.9%");
  });

  it("clicking a strike row follows that strike; the contract, the window and Follow ATM change what is asked", async () => {
    mount();
    await screen.findByTestId("sp-ladder");
    fireEvent.click(screen.getByTestId("sp-row-25550"));
    await waitFor(() => expect(calls.some((u) => u.includes("strike=25550") && u.includes("mode=fixed"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    await waitFor(() => expect(calls.some((u) => u.includes("strike=25550") && u.includes("contract=call"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Since open" }));
    await waitFor(() => expect(calls.some((u) => u.includes("window=open"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Follow ATM" }));
    await waitFor(() => expect(calls.some((u) => u.includes("mode=atm") && !u.includes("strike="))).toBe(true)); // following the ATM names no strike
    fireEvent.click(screen.getByRole("button", { name: /^ATM now/ }));
    await waitFor(() => expect(calls[calls.length - 1]).toContain("mode=fixed"));
  });

  it("following the ATM says the parts are measured on one contract at a time", async () => {
    answer = () => ({ ...sample, mode: "atm" });
    mount();
    const el = await screen.findByTestId("sp-readout");
    expect(el.textContent).toContain("The at-the-money straddle, followed as NIFTY moves, 09:20 to 15:39: −79.6 points on the contract held at each step");
    expect(screen.getByText(/jumps when the strike changes/)).toBeInTheDocument();
  });

  it("says plainly when there is nothing to split yet, and keeps the classic view one click away", async () => {
    answer = () => ({ status: "unavailable", message: "Not enough stored samples with prices to split a premium change (needs three).", rate_assumed: 0.07 });
    mount();
    expect(await screen.findByText("Nothing to split yet")).toBeInTheDocument();
    expect(screen.getByText(/needs three/)).toBeInTheDocument();
    const classic = screen.getByRole("button", { name: "ATM windows (classic)" });
    fireEvent.click(classic);
    expect(classic).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.queryByText("Nothing to split yet")).toBeNull()); // the strike view is replaced by the classic one (its own tests cover it)
  });

  it("states the assumed interest rate in the notes", async () => {
    mount();
    await screen.findByTestId("sp-notes");
    expect(screen.getByTestId("sp-notes")).toHaveTextContent("The assumed interest rate is 7%.");
  });
});

describe("strike premium helpers", () => {
  it("formats signed numbers, rupees, times and drivers", () => {
    expect(sg(-79.6)).toBe("−79.6"); expect(sg(0)).toBe("+0.0"); expect(sg(null)).toBe("—");
    expect(rupee(-5174.2)).toBe("−₹5,174"); expect(rupee(748)).toBe("+₹748");
    expect(hhmm("2026-11-27T10:09:00+00:00")).toBe("15:39");
    expect(driverText({ name: "NIFTY", value: 13.5 })).toBe("NIFTY +13.5"); expect(driverText(null)).toBe("—");
    expect(readout({ status: "unavailable", rate_assumed: 0.07 })).toBeNull();
    expect(place(0, -1, 1)).toBe(50);
  });
});
