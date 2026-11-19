import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecayOddsCard } from "../components/intelligence/DecayOdds";
import type { DecayCalibration, DecayOdds } from "../lib/decayProbability";

const odds = (over: Partial<DecayOdds> = {}): DecayOdds => ({
  available: true, strike: 25500, premium: 271.5, implied_vol_pct: 14.2, forward: 25512.3, p_profit: 0.64, mean: -0.6, rupees_per_lot_mean: -39,
  quantiles: { p5: -110, p25: -20, p50: 12.5, p75: 30, p95: 41 }, p_stop: 0.18, p_target: 0.37, p_exit_time: 0.45, p_touch_breakeven: 0.31,
  breakeven: { down: 25228.5, up: 25771.5, move_pts: 271.5 }, expected_move_pts: 190, session: "2026-11-19", expiry: "2026-11-23", as_of: "2026-11-19T04:25:00+00:00", age_minutes: 3.4, stale: false,
  exit: "15:15", stop_pct: 20, target_pct: null, cost: 2, vol_scale: 1, lines: ["In the model the straddle sold now ends lower at the exit 64% of the time.", "Break-evens are 25228 and 25772."], ...over,
});
const band = (from: number, to: number, entries: number, actual: number | null, predicted: number | null) => ({ from, to, entries, days: entries ? 3 : 0, predicted, actual });
const ready = (): DecayCalibration => ({
  status: "ready", days: 15, sufficient: false, min_days: 20, variants_tried: 5, note: "15 days: a description, not a verdict (at least 20 days are needed).",
  scales: { "1": { entries: 135, days: 15, base_rate: 0.5, brier: 0.31, brier_base_rate: 0.25, beats_base_rate: false, mean_predicted_pnl: -2, mean_actual_pnl: -14.3,
    reliability: [band(0, 0.45, 10, 0.3, 0.4), band(0.45, 0.55, 20, 0.5, 0.5), band(0.55, 0.65, 40, 0.45, 0.6), band(0.65, 0.75, 0, null, null), band(0.75, 1, 5, 0.8, 0.8)] } },
});

const urls: string[] = [];
function mount(answer: () => { body: unknown; status?: number }, cal: unknown = ready()) {
  urls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    urls.push(String(u));
    const r = String(u).includes("decay-calibration") ? { body: cal, status: 200 } : answer();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DecayOddsCard /></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("decay odds card", () => {
  it("shows the probability, the typical and the bad day in points and rupees a lot, the break-evens and the stop odds", async () => {
    mount(() => ({ body: odds() }));
    expect(await screen.findByTestId("decay-p")).toHaveTextContent("64%");
    expect(screen.getByTestId("decay-typical")).toHaveTextContent("+12.5 pts");
    expect(screen.getByTestId("decay-typical")).toHaveTextContent("₹813 a lot"); // 12.5 x 65 = 812.5
    expect(screen.getByTestId("decay-bad")).toHaveTextContent("−110 pts or worse");
    expect(screen.getByTestId("decay-bad")).toHaveTextContent("₹7,150 a lot"); // 110 x 65
    expect(screen.getByTestId("decay-be")).toHaveTextContent("25229 · 25772"); // 25228.5 and 25771.5 to the whole point
    expect(screen.getByTestId("decay-be")).toHaveTextContent("index touches one in 31% of paths");
    expect(screen.getByTestId("decay-rule")).toHaveTextContent("18% · 37% · 45%");
    expect(screen.getByTestId("decay-asof")).toHaveTextContent("Strike 25500, premium 271.5 points, implied volatility 14.2%");
    expect(screen.getByTestId("decay-lines")).toHaveTextContent("Break-evens are 25228 and 25772.");
    expect(screen.getByTestId("decay-caution")).toHaveTextContent("A model probability, not a forecast");
  });

  it("says how the model did on the recorded days for the band the probability falls in, and whether it beat the base rate", async () => {
    mount(() => ({ body: odds() })); // 64%: the 55-65% band
    expect(await screen.findByTestId("decay-cal-band")).toHaveTextContent("when the model said 55%–65% (it averaged 60%), the sale paid 45% of the time (40 entries over 3 days)");
    const sc = screen.getByTestId("decay-cal-score");
    expect(sc).toHaveTextContent("did not beat simply quoting the base rate (Brier 0.310 against 0.250)");
    expect(sc).toHaveTextContent("predicted −2.0 points and the straddle made −14.3");
    expect(sc).toHaveTextContent("a description, not a verdict");
  });

  it("says so when no recorded entry fell in the band, while the check is still running, and before it has run", async () => {
    const { unmount } = mount(() => ({ body: odds({ p_profit: 0.7 }) })); // the 65-75% band holds no entries
    expect(await screen.findByTestId("decay-cal-band")).toHaveTextContent("No recorded entry fell in this probability band.");
    unmount();
    const r2 = mount(() => ({ body: odds() }), { status: "computing", days_loaded: 4, previous: null });
    expect(await screen.findByTestId("decay-cal-computing")).toHaveTextContent("Checking the model against the recorded days (4 loaded)");
    r2.unmount();
    mount(() => ({ body: odds() }), { status: "ready", days: 0, sufficient: false, min_days: 20, variants_tried: 0, note: "", scales: {} });
    expect(await screen.findByTestId("decay-cal-none")).toBeTruthy();
  });

  it("asks again with the stop, target and exit chosen, and shows the expected result when there is no rule", async () => {
    mount(() => ({ body: odds() }));
    await screen.findByTestId("decay-p");
    fireEvent.change(screen.getByRole("combobox", { name: "Target (premium down)" }), { target: { value: "10" } });
    await waitFor(() => expect(urls.some((u) => u.includes("stop=20") && u.includes("target=10") && u.includes("exit=15%3A15"))).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Exit at" }), { target: { value: "13:00" } });
    await waitFor(() => expect(urls.some((u) => u.includes("exit=13%3A00"))).toBe(true));
  });

  it("shows the expected result instead of the rule odds when no stop or target is chosen", async () => {
    mount(() => ({ body: odds({ stop_pct: null, target_pct: null, mean: 3.2 }) }));
    expect(await screen.findByTestId("decay-rule")).toHaveTextContent("Expected result+3.2 pts");
  });

  it("flags a stale chain, says why there is nothing to show, and shows an error instead of an empty card or a crash", async () => {
    const { unmount } = mount(() => ({ body: odds({ stale: true, age_minutes: 377 }) }));
    expect(await screen.findByTestId("decay-asof")).toHaveTextContent("stale: the numbers describe that chain");
    unmount();
    const u2 = mount(() => ({ body: { available: false, reason: "too close to the exit time", as_of: "2026-11-19T10:25:00+00:00", age_minutes: 377 } }));
    expect(await screen.findByTestId("decay-unavailable")).toHaveTextContent("Not available: too close to the exit time. The newest stored chain is 377 minutes old.");
    u2.unmount();
    const u3 = mount(() => ({ body: { detail: "x" }, status: 503 }));
    expect(await screen.findByTestId("decay-error")).toBeTruthy();
    u3.unmount();
    mount(() => ({ body: { status: "unavailable", message: "no samples" } })); // not the expected shape
    expect(await screen.findByTestId("decay-error")).toBeTruthy();
  });
});
