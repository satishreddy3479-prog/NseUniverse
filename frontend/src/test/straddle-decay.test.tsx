// Straddle decay panel: renders exactly what the backend returned (fixture numbers), says plainly what is missing, never fills a gap.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StraddleDecayPanel, StraddleSummaryCard } from "../components/intelligence/StraddleDecay";
import type { Component, Environment, Stat, StraddleDecay, StraddleValidation, Terms, Window } from "../lib/straddleDecay";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option?: { series?: { data?: unknown[]; lineStyle?: { width?: number } }[] } }) => <div role="img" aria-label={ariaLabel} data-last={JSON.stringify((option?.series ?? []).map((x) => (x.data ?? []).at(-1)))} data-widths={JSON.stringify((option?.series ?? []).map((x) => x.lineStyle?.width ?? null))} />,
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
  return render(<MemoryRouter><QueryClientProvider client={qc}><StraddleDecayPanel /><StraddleSummaryCard /></QueryClientProvider></MemoryRouter>);
}

// The page is five tabs; a test opens the tab that holds what it checks (the address hash picks the first one) and, when it checks two places, clicks to the other.
const itIn = (tab: string, name: string, fn: () => Promise<void> | void) => it(name, async () => { window.location.hash = `#${tab}`; try { await fn(); } finally { window.location.hash = ""; } });
const openTab = async (name: RegExp) => fireEvent.click(await screen.findByRole("tab", { name }));

describe("straddle decay panel", () => {
  itIn("today", "shows the opening and current premiums, the attribution table and the efficiency class", async () => {
    mount(full());
    const trk = await screen.findByTestId("sdi-tracker");
    expect(within(trk).getByText("Opening CE").nextSibling?.textContent).toBe("90.0");
    expect(within(trk).getByText("Opening straddle").nextSibling?.textContent).toBe("170.0");
    expect(within(trk).getByText("Change (points)").nextSibling?.textContent).toBe("−7.0");
    expect(within(trk).getByText("Decay (%)").nextSibling?.textContent).toBe("−4.12%");
    const attr = screen.getByTestId("sdi-attr");
    const both = within(attr).getByText("Straddle (CE + PE)").closest("tr")!;
    expect(both.textContent).toContain("−10.00");
    expect(both.textContent).toContain("+2.20");
    expect(within(screen.getByTestId("sdi-attribution")).getByText("Slower than expected")).toBeTruthy();
    expect(screen.getByTestId("sdi-reason").textContent).toContain("IV expansion");
  });

  itIn("why", "answers the reading questions and labels the climate as a tally, not a forecast", async () => {
    mount(full());
    const r = await screen.findByTestId("sdi-reading");
    expect(r.textContent).toContain("decaying normally");
    expect(r.textContent).toContain("CE or PE");
    expect(screen.getByTestId("sdi-climate").textContent).toBe("mixed");
    expect(r.textContent).toContain("not a forecast");
  });

  itIn("today", "switches between fixed and rolling without mixing them", async () => {
    mount(full());
    await screen.findByTestId("sdi-tracker");
    fireEvent.click(screen.getByRole("button", { name: /^Rolling ATM \(\d+ rolls?\)$/ }));
    const trk = screen.getByTestId("sdi-tracker");
    expect(within(trk).getByText("Straddle now").nextSibling?.textContent).toBe("160.0");
    expect(trk.textContent).toContain("roll-adjusted −7.5");
    expect(within(screen.getByTestId("sdi-attribution")).getByText("Premium expansion")).toBeTruthy();
  });

  itIn("today", "says a window is not available instead of filling it", async () => {
    mount(full());
    await screen.findByTestId("sdi-tracker");
    fireEvent.click(screen.getByRole("button", { name: "Last 60 min" }));
    expect(screen.getByTestId("sdi-nowindow").textContent).toContain("nothing is filled in");
  });

  itIn("why", "shows missing IV, skew and realised-vol values as dashes and names the IV support", async () => {
    mount(full());
    const ivbox = await screen.findByTestId("sdi-iv");
    expect(within(ivbox).getByText("10Δ skew (put − call)").closest("tr")!.textContent).toContain("—");
    expect(screen.getByTestId("sdi-support").textContent).toContain("call side is carrying");
    expect(within(screen.getByTestId("sdi-rv")).getByText("30 min").closest("tr")!.textContent).toContain("—");
    expect(ivbox.textContent).toContain("not defined (spot has moved less than 0.1% since the open)");
  });

  itIn("why", "structure panel states that GEX does not guarantee low volatility", async () => {
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

  itIn("alerts", "validation is computed only when opened and says when the history is insufficient", async () => {
    const v: StraddleValidation = { generated_at: "x", window_minutes: 30, sufficient: false, message: "Insufficient: 2 session(s) and 10 window(s) (need 20 and 100).", method: "m", note: "n", sessions: [], overall: { windows: 10, ratio_actual_to_predicted: 0.8, mae: 0.4 }, earlier_half: { windows: 5, ratio_actual_to_predicted: 0.7 }, later_half: { windows: 5, ratio_actual_to_predicted: 0.9 } };
    mount(full(), v);
    await screen.findByTestId("sdi-validation");
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/validation"))).toBe(false);
    const det = screen.getByTestId("sdi-validation") as HTMLDetailsElement;
    det.open = true;
    fireEvent(det, new Event("toggle"));
    expect((await screen.findByTestId("sdi-val-message")).textContent).toContain("Insufficient");
  });
});

const comp = (id: string, name: string, value: number | null, contribution: number | null, proxy = false): Component => ({ id, name, weight: 10, value, contribution, text: value == null ? "unavailable: no reading" : `${name} reading`, source: "straddle attribution", proxy, status: value == null ? "UNAVAILABLE" : "AVAILABLE" });
const envFixture: Environment = {
  seller: { score: 76, class: "Favourable", capped_by_flags: null, coverage: 0.9, components: [comp("decay", "Theta decay efficiency", 0.8, 12.5), comp("flow", "Futures order-flow evidence", null, null, true)], flags: [{ id: "tail", text: "Asymmetric tail risk: call and put vols are moving apart" }],
    short_straddle: { score: 71, class: "Favourable", uses: [] }, short_strangle: { score: 64, class: "Favourable", uses: [] },
    call_side_risk: { risk: 30, label: "Low", reasons: [{ name: "x", value: 0.1, text: "evidence leans mixed (+0.10)" }] }, put_side_risk: { risk: 62, label: "Elevated", reasons: [{ name: "y", value: 0.4, text: "put-skew richness" }] }, note: "A favourable seller environment is not a guarantee of profit." },
  buyer: { score: 24, class: "Unfavourable", coverage: 0.8, components: [comp("iv_up", "ATM IV expansion", -0.2, -3)], types: { directional: { score: 30, state: "inactive", uses: [], name: "Directional option-buying environment", direction: "mixed or balanced" }, vol_expansion: { score: 20, state: "inactive", uses: [], name: "Volatility-expansion buying environment" },
    gamma_momentum: { score: 25, state: "inactive", uses: [], name: "Gamma-driven momentum environment" }, low_movement: { score: 71, state: "decay-favourable", uses: [], name: "Low-movement premium-decay environment" } },
    direction: { value: 0.1, label: "mixed or balanced", parts: [{ name: "futures CVD (proxy)", value: 0.1 }] }, premium_check: { iv_rising_but_not_justified: true, text: "IV is rising but realised movement is below what the premium prices: rising IV alone does not justify paying for options." }, note: "n" },
  positioning: { status: "AVAILABLE", supports: true, lines: ["Largest put OI 23700 below and largest call OI 24300 above spot."] }, invalidation: ["Realised volatility over 15 minutes rises above the implied vol"], proxies: ["CVD (quote and tick rule estimate, no trade tape)"], weights_note: "Provisional working weights: not a signal.",
  sources: { seller_inputs: ["straddle attribution"], buyer_inputs: ["straddle IV"] },
  comparison: { verdict: "favours sellers", text: "Premium-decay conditions currently favour sellers, subject to the risk flags and checks shown.", seller_score: 76, buyer_score: 24, same_sign_in_both: [], conflicting_seller: ["Skew changes"], conflicting_buyer: [],
    top_seller: [{ name: "Theta decay efficiency", contribution: 12.5, text: "recent decay 95% of theta" }], top_buyer: [{ name: "ATM IV expansion", contribution: -3, text: "ATM IV -0.20 vol points" }] },
};
const rich = (): StraddleDecay => full({
  environment: envFixture, environment_trend: { seller: { now: 76, m15: 70, m30: null }, buyer: { now: 24, m15: 30, m30: null } },
  alerts: [{ id: 1, at: "2026-11-11T05:00:00Z", kind: "Put IV expansion", severity: "medium", direction: "bearish", text: "Put IV is up +1.30 vol points in 15 minutes", evidence: [] }],
  sources: [{ id: "chain", name: "Option chain samples", as_of: "2026-11-11T05:15:00Z", age_s: 60, status: "AVAILABLE", reliability: "last traded" }, { id: "gex", name: "GEX history (modelled)", as_of: null, age_s: null, status: "UNAVAILABLE", reliability: "no provider" }],
  context: { as_of: "2026-11-11T05:15:00Z", volatility: { skew_25d: 1.2, skew_10d: null, risk_reversal_25d: -1.2, butterfly_25d: 0.4, term_slope_30d: 0.5, term_shape: "contango", term: [{ expiry: "2026-11-17", days: 6, atm_iv: 15.1 }, { expiry: "2026-11-24", days: 13, atm_iv: 15.9 }], atm_iv: 15.1, expected_move_1sd_pts: 200 },
    options: { ce_oi: 1, pe_oi: 1, ce_oi_change: 5000, pe_oi_change: -2000, pcr_oi: 0.95, pcr_vol: 1.0, max_ce_oi_strike: 24300, max_pe_oi_strike: 23700, largest_call_additions: [{ strike: 24300, change: 90000 }], largest_put_additions: [], largest_call_unwinding: [], largest_put_unwinding: [{ strike: 23900, change: -40000 }], demand: [], window: "15", note: null },
    futures: { oi_change: 1200, buildup: "Long buildup", vwap: { distance_pct: 0.05, side: "above" }, flow: { cvd_pct: 3 }, note: null }, heavyweights: { aggregate: { "15": { score: 12 } }, participation: { class: "Broad heavyweight buying" }, method: "proxy" }, groups: {}, gex: null },
  attribution: { fixed: { open: { ...win(eff("slower", 60, "IV expansion (parallel) added 2.2 points")), both: { ...terms(-10, 2.2, 0.1, 0.9), vanna: 0.1, volga: 0.05, vega_skew: 0.4 }, efficiency: { ...eff("slower", 60, "IV expansion (parallel) added 2.2 points against 10.0 points of theta"), shortfall: 4, shortfall_rupees: 260, shortfall_pct: 40, causes: { "IV expansion (parallel)": 1.8, "skew change (call and put vols moving apart)": 0.4 } } }, "60": null, "30": null }, rolling: { open: null, "60": null, "30": null } },
  tracker: { ...full().tracker!, atm_open: 24000, atm_now: 24050, moves: { fixed: { straddle: { "5": -0.4, "15": -1.2, "30": -2.4, "60": null }, ce: { "5": null, "15": null, "30": null, "60": null }, pe: { "5": null, "15": null, "30": null, "60": null } }, rolling_adjusted: { straddle: { "5": null, "15": null, "30": null, "60": null } } },
    difference: { fixed_minus_rolling_now: 3.2, fixed_change: -7, rolling_adjusted_change: -7.5, note: "The fixed series is one contract pair." } },
  regime: { label: "volatility compression", reasons: ["ATM IV moved -0.60 points over the recent window"], accel: { ratio: 0.8, label: "steady", now_15m: 10, previous_15m: 12.5 }, path_efficiency_30m: 0.2, note: "n" },
  retention: { side: "CE", text: "The CE retains more premium: CE 94% and PE 98% of the opening price." },
  structure: { ...full().structure!, gex_session: { first_net: 900, latest_net: 1250, min_net: 700, max_net: 1300, net_change: 350, points: 40, flip_crossings: 2 }, config: [{ tag: "suppressed movement", why: "modelled net GEX is positive" }], assumption: "GEX is modelled exposure." },
});

describe("environments and the twelve sections", () => {
  itIn("why", "shows both scores independently with the interpretation, evidence, conflicts and invalidation", async () => {
    mount(rich());
    expect((await screen.findByTestId("sdi-seller-top-score")).textContent).toBe("76");
    expect(screen.getByTestId("sdi-buyer-top-score").textContent).toBe("24");
    expect(screen.getByTestId("sdi-verdict").textContent).toContain("favour sellers");
    expect(screen.getByTestId("sdi-conflicts").textContent).toContain("Skew changes");
    expect(screen.getByTestId("sdi-invalidation").textContent).toContain("Realised volatility over 15 minutes");
    expect(screen.getByTestId("sdi-regime").textContent).toContain("volatility compression");
  });

  it("each tab holds its own sections, and the page opens on the reading", async () => {
    mount(rich());
    expect(await screen.findByTestId("sdi-reading-card")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview", "Today's premium", "Why these scores", "Alerts & checks", "Method"]);
    const ids: Record<string, string[]> = {
      "Today's premium": ["sdi-tracker", "sdi-attribution"],
      "Why these scores": ["sdi-overall", "sdi-buyer", "sdi-seller", "sdi-iv", "sdi-rv", "sdi-structure", "sdi-positioning"],
      "Alerts & checks": ["sdi-alerts", "sdi-validation"],
      Method: ["sdi-method"],
    };
    for (const [tab, list] of Object.entries(ids)) {
      await openTab(new RegExp(tab.replace("'", "'")));
      for (const id of list) expect(await screen.findByTestId(id), `${tab}: ${id}`).toBeInTheDocument();
      expect(screen.queryByTestId("sdi-reading-card")).toBeNull(); // the reading lives on the Overview only
    }
    expect(window.location.hash).toBe("#method"); // a reload or a link opens the same tab
    window.location.hash = "";
  });

  itIn("why", "buyer types, premium check, seller sub-assessments and flags", async () => {
    mount(rich());
    const b = await screen.findByTestId("sdi-buyer");
    expect(within(b).getByText(/Low-movement premium-decay environment/)).toBeTruthy();
    expect(screen.getByTestId("sdi-premium-check").textContent).toContain("does not justify paying");
    const s = screen.getByTestId("sdi-seller");
    expect(within(s).getByText("Call-side selling risk").nextSibling?.textContent).toBe("30 · Low");
    expect(within(s).getByText("Put-side selling risk").nextSibling?.textContent).toBe("62 · Elevated");
    expect(screen.getByTestId("sdi-flags").textContent).toContain("Asymmetric tail risk");
  });

  itIn("why", "unavailable components are dashes, flagged as such, and proxies are labelled", async () => {
    mount(rich());
    await screen.findByTestId("sdi-evidence");
    const flow = screen.getByTestId("sdi-comp-flow");
    expect(flow.textContent).toContain("—");
    expect(flow.textContent).toContain("unavailable");
    expect(flow.textContent).toContain("PROXY");
  });

  itIn("today", "attribution includes vanna, volga, residual, rupee shortfall, causes and the skew part of vega", async () => {
    mount(rich());
    const a = await screen.findByTestId("sdi-attribution");
    expect(within(a).getByText("Vanna")).toBeTruthy();
    expect(within(a).getByText("Volga")).toBeTruthy();
    expect(within(a).getByText("Residual")).toBeTruthy();
    expect(screen.getByTestId("sdi-shortfall").textContent).toContain("₹260");
    expect(screen.getByTestId("sdi-causes").textContent).toContain("skew change");
    expect(a.textContent).toContain("skew): +0.40 points");
  });

  itIn("today", "decay faster than theta is not shown as a negative shortfall", async () => {
    const r = rich();
    const w0 = r.attribution!.fixed.open!;
    r.attribution!.fixed.open = { ...w0, efficiency: { ...w0.efficiency, status: "efficient", efficiency_pct: 113, shortfall: -1.2, shortfall_rupees: -77, shortfall_pct: -13 } };
    mount(r);
    const t = (await screen.findByTestId("sdi-shortfall")).textContent ?? "";
    expect(t).toContain("No shortfall");
    expect(t).toContain("₹77");
    expect(t).not.toContain("-77");
  });

  itIn("today", "tracker shows premium moves over 5, 15, 30 and 60 minutes and the fixed-versus-rolling difference", async () => {
    mount(rich());
    const m = await screen.findByTestId("sdi-moves");
    const row = within(m).getByText("Fixed straddle").closest("tr")!;
    expect(row.textContent).toContain("−2.40");
    expect(row.textContent).toContain("—");
    expect(screen.getByTestId("sdi-fixed-vs-rolling").textContent).toContain("+3.2");
  });

  itIn("why", "IV panel names the term structure, the retaining side and the gamma configuration", async () => {
    mount(rich());
    await screen.findByTestId("sdi-iv");
    expect(screen.getByTestId("sdi-term").textContent).toContain("2026-11-24");
    expect(screen.getByTestId("sdi-retention").textContent).toContain("CE retains more");
    expect(screen.getByTestId("sdi-gex-session").textContent).toContain("crossed the flip 2 time(s)");
    expect(screen.getByTestId("sdi-gamma-config").textContent).toContain("suppressed movement");
  });

  itIn("alerts", "alerts and sources", async () => {
    mount(rich());
    const alertsPane = await screen.findByTestId("sdi-alerts");
    expect(alertsPane).toBeInTheDocument();
    expect(screen.getByTestId("sdi-alert-list").textContent).toContain("Put IV expansion");
    await openTab(/Method/);
    const src = await screen.findByTestId("sdi-sources");
    expect(src.textContent).toContain("UNAVAILABLE");
    expect(src.textContent).toContain("AVAILABLE");
  });

  itIn("why", "without live inputs the environment is not invented", async () => {
    mount(full({ environment: null, environment_note: "Buyer and seller environments are computed for the live session only." }));
    expect((await screen.findByTestId("sdi-env-none")).textContent).toContain("live session only");
    expect(screen.queryByTestId("sdi-seller-top")).toBeNull();
    expect(screen.getByTestId("sdi-pos-none").textContent).toContain("UNAVAILABLE");
    await openTab(/Alerts & checks/);
    expect(await screen.findByTestId("sdi-alerts-none")).toBeTruthy();
  });

  it("summary card shows both scores and a link to the full page", async () => {
    mount(rich());
    expect((await screen.findByTestId("sdi-card-seller-score")).textContent).toBe("76");
    const card = screen.getByTestId("sdi-card");
    expect(within(card).getByRole("link", { name: /full analysis/ }).getAttribute("href")).toBe("/market-intelligence/straddle");
  });

  itIn("alerts", "environment validation is shown with its assumptions and says when it is insufficient", async () => {
    const v: StraddleValidation = { generated_at: "x", window_minutes: 30, sufficient: false, message: "Insufficient: 2 session(s).", method: "m", note: "n", sessions: [], overall: { windows: 0 }, earlier_half: { windows: 0 }, later_half: { windows: 0 },
      environment: { sessions: 2, sufficient: false, message: "Insufficient: 2 recorded session(s) (need 20) and not enough picks per bucket (need 30).", assumptions: "Costs are an assumption: 0.5 point per leg per trade.", limits: ["Seller result is a short ATM straddle proxy"],
        table: { seller: { "15": { "high (>=60)": { n: 4, mean_result_pts: 3.2, median_result_pts: 2.5, max_adverse_pts: 6, max_drawdown_pts: -4, win_rate_pct: 75, expiry_day: { n: 0 }, non_expiry_day: { n: 4 }, earlier_sessions: { n: 4 }, later_sessions: { n: 0 } } } }, buyer: {} } } };
    mount(rich(), v);
    await screen.findByTestId("sdi-validation");
    const det = screen.getByTestId("sdi-validation") as HTMLDetailsElement;
    det.open = true;
    fireEvent(det, new Event("toggle"));
    expect((await screen.findByTestId("sdi-env-val-message")).textContent).toContain("Insufficient");
    expect(screen.getByTestId("sdi-env-validation").textContent).toContain("Costs are an assumption");
    expect(screen.getByTestId("sdi-env-validation").textContent).toContain("+3.20");
  });
});


describe("audit fixes (12 Nov 2026)", () => {
  itIn("today", "says what the Fixed position is: the strike that was ATM at the open, not today's ATM", async () => {
    mount(full({ spot: Array.from({ length: 90 }, (_, i) => 25175 + i), tracker: { ...full().tracker!, atm_open: 25200, atm_now: 25350, opening_at: "2026-11-11T03:45:04Z", fixed: { ...full().tracker!.fixed, strike: 25200 } } }));
    const btn = await screen.findByRole("button", { name: /^Fixed 25200 · ATM at open$/ });
    expect(btn).toHaveTextContent("ATM at open");
    expect(btn.getAttribute("title")).toContain("not the current ATM strike");
    const note = screen.getByTestId("sdi-position-note");
    expect(note).toHaveTextContent("the strike nearest NIFTY at the first usable sample");
    expect(note).toHaveTextContent("NIFTY 25,175");
    expect(note).toHaveTextContent("at-the-money strike is 25350");
    fireEvent.click(screen.getByRole("button", { name: /^Rolling ATM \(\d+ rolls?\)$/ }));
    expect(screen.getByTestId("sdi-position-note")).toHaveTextContent("Rolling position");
  });

  itIn("today", "a window whose expected decay is tiny reads Too early to judge, not a percentage", async () => {
    const e = { status: "low_signal" as const, efficiency_pct: null, actual_decay: 3.7, expected_decay: 0.7, reason: "Too early to judge: time alone is expected to take only 0.7 points", confidence: 0 };
    const f = full();
    mount(full({ attribution: { ...f.attribution!, fixed: { ...f.attribution!.fixed, open: { ...f.attribution!.fixed.open!, efficiency: e } } } }));
    const att = await screen.findByTestId("sdi-attribution");
    expect(within(att).getAllByText("Too early to judge").length).toBeGreaterThan(0);
    expect(att).toHaveTextContent("expected decay only 0.7 pts: too small to judge");
    expect(screen.getByTestId("sdi-reason").textContent).toContain("Too early to judge");
  });

  itIn("overview", "the score history ends with the current reading, so the chart and the cards show the same numbers", async () => {
    const d = rich();
    mount({ ...d, generated_at: "2026-11-11T04:10:30Z", history: { times: ["2026-11-11T04:08:00Z", "2026-11-11T04:09:00Z"], seller: [60.2, 48.7], buyer: [48, 53.7], regime: [null, null], eff30: [null, null], spot: [1, 2] } });
    expect((await screen.findByTestId("sdi-gauge-seller-score")).textContent).toBe("76");
    const chart = await screen.findByRole("img", { name: "Seller and buyer environment score history" });
    const last = JSON.parse(chart.getAttribute("data-last") ?? "[]") as [number, number][];
    expect(last.map((x) => x[1])).toEqual([76, 24]); // the cards' seller and buyer scores
    expect(last[0]![0]).toBe(Date.parse("2026-11-11T04:10:30Z"));
    expect(screen.getByTestId("sdi-hist-note")).toHaveTextContent("last point is the current reading");
  });

  itIn("overview", "after the close the history ends at the last recorded minute instead of drawing a flat line to the time the page was opened", async () => {
    const d = rich();
    mount({ ...d, generated_at: "2026-11-11T12:16:00Z", history: { times: ["2026-11-11T09:58:00Z", "2026-11-11T09:59:00Z"], seller: [60.2, 48.7], buyer: [48, 53.7], regime: [null, null], eff30: [null, null], spot: [1, 2] } }); // opened at 17:46 IST
    const chart = await screen.findByRole("img", { name: "Seller and buyer environment score history" });
    const last = JSON.parse(chart.getAttribute("data-last") ?? "[]") as [number, number][];
    expect(last[0]![0]).toBe(Date.parse("2026-11-11T09:59:00Z")); // 15:29 IST, the last recorded minute: nothing appended
    expect(screen.getByTestId("sdi-hist-note")).toHaveTextContent("market is closed");
    expect(screen.getByTestId("sdi-hist-note")).toHaveTextContent("15:29");
  });

  itIn("overview", "when the newest recorded minute is as new as the reading, nothing is appended", async () => {
    const d = rich();
    mount({ ...d, generated_at: "2026-11-11T04:09:00Z", history: { times: ["2026-11-11T04:08:00Z", "2026-11-11T04:09:00Z"], seller: [60.2, 48.7], buyer: [48, 53.7], regime: [null, null], eff30: [null, null], spot: [1, 2] } });
    const chart = await screen.findByRole("img", { name: "Seller and buyer environment score history" });
    const last = JSON.parse(chart.getAttribute("data-last") ?? "[]") as [number, number][];
    expect(last.map((x) => x[1])).toEqual([48.7, 53.7]);
  });
});

describe("the glance (12 Nov 2026)", () => {
  itIn("overview", "shows both scores as gauges, a plain-words reading and the reasons behind each score", async () => {
    mount(rich());
    expect((await screen.findByTestId("sdi-gauge-seller-score")).textContent).toBe("76");
    expect(screen.getByTestId("sdi-gauge-buyer-score").textContent).toBe("24");
    expect(screen.getByTestId("sdi-glance-verdict")).toHaveTextContent("In plain words");
    await openTab(/Why these scores/);
    expect(await screen.findByRole("img", { name: "What moves the seller score" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "What moves the buyer score" })).toBeInTheDocument();
    await openTab(/Method/);
    expect(await screen.findByTestId("sdi-words")).toHaveTextContent("Decay efficiency");
    // a seller score whose label is held down by a risk flag says so next to the gauge
    expect(screen.queryByTestId("sdi-gauge-seller-cap")).toBeNull();
  });

  itIn("today", "compares the fixed and the rolling position side by side, with the seller's rupee result, and always shows both", async () => {
    const f = full();
    mount(full({ spot: Array.from({ length: 90 }, (_, i) => 24000 + i), tracker: { ...f.tracker!, atm_now: 24050, fixed: { ...f.tracker!.fixed, straddle: stat(170, 163) }, rolling: { ...f.tracker!.rolling, adjusted_change: -5.5, straddle: stat(170, 160), rolls: 3 } },
      attribution: { ...f.attribution!, fixed: { ...f.attribution!.fixed, open: { ...f.attribution!.fixed.open!, efficiency: { ...f.attribution!.fixed.open!.efficiency, lot_size: 65 } } } } }));
    const fx = await screen.findByTestId("sdi-compare-fixed");
    const rl = screen.getByTestId("sdi-compare-rolling");
    expect(fx).toHaveTextContent("Fixed 24000");
    expect(fx).toHaveTextContent("−7.0"); // 163 - 170
    expect(fx).toHaveTextContent("₹455 per lot"); // 7 x 65, a seller who sold at the open
    expect(rl).toHaveTextContent("Rolling ATM (now 24050)");
    expect(rl).toHaveTextContent("−5.5");
    expect(rl).toHaveTextContent("₹358 per lot"); // 5.5 x 65 = 357.5
    expect(fx).toHaveTextContent("shown in the sections below"); // fixed is the selected one
    fireEvent.click(rl);
    expect(rl).toHaveTextContent("shown in the sections below");
    expect(screen.getByTestId("sdi-position-note")).toHaveTextContent("Rolling position");
    expect(screen.getByTestId("sdi-following-note")).toHaveTextContent("You are following Rolling ATM (now 24050)");
    expect(screen.getByRole("img", { name: /Change in straddle premium since the open/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Causes of the premium change/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Call and put premium at the open and now/ })).toBeInTheDocument();
    await openTab(/Method/);
    expect(await screen.findByTestId("sdi-plotted")).toHaveTextContent("only the change of the same contract");
  });
});

describe("the glance: a label held down by a risk flag", () => {
  it("explains why the marker sits in a higher zone than the label", async () => {
    const d = rich();
    mount({ ...d, environment: { ...d.environment!, seller: { ...d.environment!.seller, capped_by_flags: "Neutral", class: "Neutral", score: 75 } } });
    const note = await screen.findByTestId("sdi-gauge-seller-cap");
    expect(note).toHaveTextContent("held at Neutral because a risk flag is active");
  });
});


describe("choosing a position changes the glance charts", () => {
  itIn("today", "the followed line is bold and the other faded, in both directions", async () => {
    mount(full({ spot: Array.from({ length: 90 }, (_, i) => 24000 + i) }));
    const chart = () => screen.getByRole("img", { name: /Change in straddle premium since the open/ });
    const widths = () => JSON.parse(chart().getAttribute("data-widths") ?? "[]") as (number | null)[]; // [fixed, rolling, NIFTY]
    await screen.findByTestId("sdi-follow");
    expect(widths()[0]!).toBeGreaterThan(widths()[1]!); // fixed is followed by default
    fireEvent.click(within(screen.getByTestId("sdi-follow")).getByRole("button", { name: "Rolling ATM" }));
    expect(widths()[1]!).toBeGreaterThan(widths()[0]!);
    expect(screen.getByTestId("sdi-following-note")).toHaveTextContent("You are following Rolling ATM");
    expect(screen.getByRole("img", { name: /Call and put premium at the open and now/ })).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("sdi-follow")).getByRole("button", { name: /^Fixed/ }));
    expect(widths()[0]!).toBeGreaterThan(widths()[1]!);
  });
});


describe("the redesigned page: a reading first, five tabs", () => {
  it("opens on the reading: plain words, both gauges, where the straddle is, what holds the scores back and what would change them", async () => {
    mount(rich());
    const card = await screen.findByTestId("sdi-reading-card");
    expect(within(card).getByTestId("sdi-glance-verdict")).toHaveTextContent("In plain words");
    expect(within(card).getByTestId("sdi-gauge-seller-score")).toHaveTextContent("76");
    expect(within(card).getByTestId("sdi-gauge-buyer-score")).toHaveTextContent("24");
    const pos = within(card).getByTestId("sdi-reading-positions");
    expect(pos).toHaveTextContent("Fixed 24000");
    expect(pos).toHaveTextContent("Rolling ATM");
    expect(within(card).getByTestId("sdi-reading-invalidation")).toBeInTheDocument();
    expect(card).toHaveTextContent("not a trading signal");
    expect(screen.queryByTestId("sdi-tracker")).toBeNull(); // the numbers live in the other tabs
  });
});
