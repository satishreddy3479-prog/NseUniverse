// Straddle decay panel: renders exactly what the backend returned (fixture numbers), says plainly what is missing, never fills a gap.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StraddleDecayPanel } from "../components/intelligence/StraddleDecay";
import type { Stat, StraddleDecay, StraddleValidation, Terms, Window } from "../lib/straddleDecay";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

const stat = (o: number | null, c: number | null): Stat => ({ open: o, current: c, change: o == null || c == null ? null : Math.round((c - o) * 100) / 100, change_pct: o == null || c == null ? null : Math.round(((c - o) / o) * 10000) / 100 });
const terms = (theta: number, vega: number, delta: number, gamma: number): Terms => ({ theta, vega, delta, gamma, residual: 0, actual: theta + vega + delta + gamma });
const eff = (status: "efficient" | "slower" | "none" | "expansion", pct: number, reason: string) => ({ status, efficiency_pct: pct, actual_decay: 6, expected_decay: 10, shortfall: 4, reason });
// call: theta -6, vega +1, delta 0.8, gamma 0.4 ; put: theta -4, vega +1.2, delta -0.7, gamma 0.5 ; straddle = sum
const win = (e: Window["efficiency"]): Window => ({ ce: terms(-6, 1, 0.8, 0.4), pe: terms(-4, 1.2, -0.7, 0.5), both: terms(-10, 2.2, 0.1, 0.9), steps: 89, efficiency: e });
const series = (n: number) => Array.from({ length: n }, (_, i) => 100 - i * 0.1);
const full = (over: Partial<StraddleDecay> = {}): StraddleDecay => ({
  status: "ok", session: "2026-11-11", expiry: "2026-11-12", samples: 90, proxies: "Last traded prices (not bid/ask).", times: Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 10, 11, 3, 46 + i)).toISOString()),
  tracker: { fixed: { strike: 24000, ce: stat(90, 85), pe: stat(80, 78), straddle: stat(170, 163) }, rolling: { ce: stat(90, 86), pe: stat(80, 77), straddle: stat(170, 160), rolls: 3, adjusted_change: -7.5 }, opening_at: "2026-11-11T03:46:00Z" },
  series: { rolling: { strike: [], ce: series(90), pe: series(90), straddle: series(90), ce_iv: series(90), pe_iv: series(90), iv: series(90) }, fixed: { strike: [], ce: series(90), pe: series(90), straddle: series(90), ce_iv: series(90), pe_iv: series(90), iv: series(90) },
    skew25: [], skew10: [], rr25: [], rr10: [] },
  iv: { fixed: { ce: stat(15, 15.6), pe: stat(15.2, 15.3), combined: stat(15.1, 15.45) }, rolling: { ce: stat(15, 15.5), pe: stat(15, 15.4), combined: stat(15, 15.45) }, skew25: stat(1.2, 1.5), skew10: stat(2.1, null), rr25: stat(-1.2, -1.5), rr10: stat(-2.1, null),
    per_spot_pct: null, iv_vs_spot: { slope_pts_per_pct: null, corr: null, pairs: 4, note: "n" }, support: { side: "call", text: "Call IV is up +0.6 points while put IV is +0.1: the call side is carrying the support." } },
  attribution: { fixed: { open: win(eff("slower", 60, "IV expansion (vega) added 2.2 points against 10.0 points of theta")), "60": null, "30": win(eff("efficient", 100, "none: decay is close to theta")) }, rolling: { open: win(eff("expansion", -20, "spot movement through gamma added")), "60": null, "30": null } },
  cumulative: { fixed: { theta: series(90), vega: series(90), delta: series(90), gamma: series(90), residual: series(90), actual: series(90) }, rolling: { theta: series(90), vega: series(90), delta: series(90), gamma: series(90), residual: series(90), actual: series(90) } },
  realised_vs_implied: { windows: { "5": { minutes: 5, vol_pct: 11.2, returns: 5, gaps_skipped: 0 }, "15": { minutes: 15, vol_pct: 12.4, returns: 15, gaps_skipped: 0 }, "30": { minutes: 30, vol_pct: null, returns: 3, gaps_skipped: 0, note: "covered 12 of 30 minutes" }, "60": { minutes: 60, vol_pct: null, returns: 0, gaps_skipped: 0 }, open: { minutes: null, vol_pct: 13, returns: 89, gaps_skipped: 0 } },
    iv_now: 15.45, iv_open: 15, gap: { "5": 4.25, "15": 3.05, "30": null, "60": null, open: 2.45 }, implied_move_pts: 163, implied_move_pct: 0.68, implied_daily_sd_pts: 233, actual_move_pts: 42, actual_range_pts: 90, move_vs_daily_sd: 0.18, realised_variance: { sum_sq_returns: 0.0001, session_move_sd_pct: 0.094, returns: 89 }, note: "annualised on trading minutes" },
  structure: { gex: { at: null, net: 1.25, regime: "positive", flip: 23850, flip_distance_pts: 150, flip_distance_pct: 0.6, net_change_15m: null, relationship: "none", spot_change_15m_pct: null }, concentration: { share_pct: 58.3, atm: 24000, contracts_missing: 0, scope: "x" },
    straddle_theta_per_day: -140, straddle_gamma: 0.0012, breakeven_daily_move_pts: 150, realised_daily_sd_pts: 120, realised_vs_breakeven: 0.8, spot_move_pts: 42, note: "Net GEX describes dealer positioning; it does not guarantee low volatility." },
  quality: { last_sample_at: "2026-11-11T05:15:00Z", age_minutes: 1, stale: false, live: true, steps_skipped_fixed: 0, steps_skipped_rolling: 2, forward_fallbacks: 0, estimated: ["implied volatility and Greeks (model, assumed rate)"], stride_note: "" },
  interpretation: [{ q: "Is the straddle decaying normally?", a: "Since the open the 24000 straddle has decayed slower than theta alone would give." }, { q: "Which side, CE or PE, is retaining more premium?", a: "The CE is retaining more: CE at 94% and PE at 98%." }],
  climate: { label: "mixed", tally: 0, because: ["recent decay slower"], window: "since open", note: "A tally of the readings above, not a forecast." },
  ...over,
});
function mount(body: unknown, validation?: StraddleValidation, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const v = String(url).includes("/validation") ? validation : body;
    return new Response(JSON.stringify(v ?? {}), { status: status, headers: { "content-type": "application/json" } });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StraddleDecayPanel /></QueryClientProvider>);
}

describe("straddle decay panel", () => {
  it("shows the opening and current premiums, the attribution table and the efficiency class", async () => {
    mount(full());
    const trk = await screen.findByTestId("sdi-tracker");
    expect(within(trk).getByText("Opening CE").nextSibling?.textContent).toBe("90.0");
    expect(within(trk).getByText("Opening straddle").nextSibling?.textContent).toBe("170.0");
    expect(within(trk).getByText("Change (points)").nextSibling?.textContent).toBe("−7.0");
    expect(within(trk).getByText("Change (%)").nextSibling?.textContent).toBe("−4.12%");
    const attr = screen.getByTestId("sdi-attr");
    const both = within(attr).getByText("Straddle (CE + PE)").closest("tr")!;
    expect(both.textContent).toContain("−10.00");
    expect(both.textContent).toContain("+2.20");
    expect(within(screen.getByTestId("sdi-attribution")).getByText("Slower than expected")).toBeTruthy();
    expect(screen.getByTestId("sdi-reason").textContent).toContain("IV expansion");
  });

  it("answers the reading questions and labels the climate as a tally, not a forecast", async () => {
    mount(full());
    const r = await screen.findByTestId("sdi-reading");
    expect(r.textContent).toContain("decaying normally");
    expect(r.textContent).toContain("CE or PE");
    expect(screen.getByTestId("sdi-climate").textContent).toBe("mixed");
    expect(r.textContent).toContain("not a forecast");
  });

  it("switches between fixed and rolling without mixing them", async () => {
    mount(full());
    await screen.findByTestId("sdi-tracker");
    fireEvent.click(screen.getByRole("button", { name: /Rolling ATM/ }));
    const trk = screen.getByTestId("sdi-tracker");
    expect(within(trk).getByText("Straddle now").nextSibling?.textContent).toBe("160.0");
    expect(trk.textContent).toContain("roll-adjusted −7.5");
    expect(within(screen.getByTestId("sdi-attribution")).getByText("Premium expansion")).toBeTruthy();
  });

  it("says a window is not available instead of filling it", async () => {
    mount(full());
    await screen.findByTestId("sdi-tracker");
    fireEvent.click(screen.getByRole("button", { name: "Last 60 min" }));
    expect(screen.getByTestId("sdi-nowindow").textContent).toContain("nothing is filled in");
  });

  it("shows missing IV, skew and realised-vol values as dashes and names the IV support", async () => {
    mount(full());
    const ivbox = await screen.findByTestId("sdi-iv");
    expect(within(ivbox).getByText("10Δ skew (put − call)").closest("tr")!.textContent).toContain("—");
    expect(screen.getByTestId("sdi-support").textContent).toContain("call side is carrying");
    expect(within(screen.getByTestId("sdi-rv")).getByText("30 min").closest("tr")!.textContent).toContain("—");
    expect(ivbox.textContent).toContain("not defined (spot has moved less than 0.1% since the open)");
  });

  it("structure panel states that GEX does not guarantee low volatility", async () => {
    mount(full());
    const s = await screen.findByTestId("sdi-structure");
    expect(s.textContent).toContain("does not guarantee low volatility");
    expect(s.textContent).toContain("58.3%");
  });

  it("flags stale data", async () => {
    mount(full({ quality: { ...full().quality!, stale: true, age_minutes: 42 } }));
    expect((await screen.findByTestId("sdi-stale")).textContent).toContain("42");
  });

  it("empty and error states", async () => {
    mount({ status: "unavailable", message: "Fewer than two usable stored samples.", interpretation: [] });
    expect((await screen.findByTestId("sdi-empty")).textContent).toContain("Fewer than two");
  });
  it("error state", async () => {
    mount({ detail: { message: "off" } }, undefined, 404);
    expect(await screen.findByTestId("sdi-error")).toBeTruthy();
  });

  it("validation is computed only when opened and says when the history is insufficient", async () => {
    const v: StraddleValidation = { generated_at: "x", window_minutes: 30, sufficient: false, message: "Insufficient: 2 session(s) and 10 window(s) (need 20 and 100).", method: "m", note: "n", sessions: [], overall: { windows: 10, ratio_actual_to_predicted: 0.8, mae: 0.4 }, earlier_half: { windows: 5, ratio_actual_to_predicted: 0.7 }, later_half: { windows: 5, ratio_actual_to_predicted: 0.9 } };
    mount(full(), v);
    await screen.findByTestId("sdi-tracker");
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/validation"))).toBe(false);
    const det = screen.getByTestId("sdi-validation") as HTMLDetailsElement;
    det.open = true;
    fireEvent(det, new Event("toggle"));
    expect((await screen.findByTestId("sdi-val-message")).textContent).toContain("Insufficient");
  });
});
