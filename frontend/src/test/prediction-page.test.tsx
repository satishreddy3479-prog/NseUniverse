import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import type { CallStats, ModelEval, ModelForecast, PredictionSummary, Verdict } from "../lib/types";
import { expiries, status, summary } from "./fixtures";

const meval = (verdict: Verdict, gain = 0.0007): ModelEval => ({
  description: "desc", params: { l2: 50 },
  holdout: { n: 1750, brier: 0.2485, log_loss: 0.69, hit: 0.545, hit_ci: [0.52, 0.56], gain, gain_ci95: [-0.0005, 0.002], gain_ci_strict_low: -0.001, skill: 0.003, verdict },
  tuning: { n: 1750, brier: 0.2486, gain: 0.001, skill: 0.004 },
  calibration: [{ low: 0.5, high: 0.6, n: 1500, predicted: 0.53, observed: 0.54 }],
  folds: [{ start: "2012-01-17", end: "2013-01-10", n: 250, brier_model: 0.249, brier_base: 0.25, phase: "tuning" }],
});
const call = { call: null, reason: "models disagree", strength: 0.03, threshold: 0.12 };
const fc = (t: string, p: number, extra: Partial<ModelForecast> = {}): ModelForecast => ({
  reference_session: "2026-10-28", reference_close: 22698.85, first_target_session: "2026-10-29", target_session: t, recorded: true, forecast_id: `id-${t}-${p}`,
  payload: { p_up_model: p, p_up_raw: p, p_up_climatology: 0.528, p_up_climatology_recent_750: 0.516, model_verdict: "no_difference", params: null,
    call: null, call_reason: null, call_strength: null, call_threshold: null,
    return_quantiles_climatological: { "0.05": -0.0135, "0.25": -0.004, "0.5": 0.0003, "0.75": 0.0049, "0.95": 0.0126 },
    top_drivers: [{ feature: "spx_ret", log_odds: 0.2, value: 0.01 }] }, ...extra,
});
const names = ["logit-all", "logit-core", "boost-all", "ensemble"];
const calls = (verdict: "promising" | "no_edge_shown"): CallStats => ({ threshold: 0.12, rule: "all agree", n_holdout: 1750, n_called: 714, coverage: 0.41, hit: 0.677, hit_ci: [0.64, 0.71], always_up_hit: 0.529, always_up_ci: [0.49, 0.566], verdict });
function hz(t: string, v: Verdict, c: CallStats, extra: Partial<ModelForecast> = {}) {
  return {
    ev: { available: true, n_labelled: 4600, tuning_period: ["2012-01-17", "2019-03-15"] as [string, string], holdout_period: ["2019-03-18", "2026-04-23"] as [string, string],
      base: { brier_holdout: 0.2487, brier_coin_flip: 0.25, up_rate_holdout: 0.54 }, best_on_tuning: "ensemble", method: "block", calls: c,
      models: Object.fromEntries(names.map((n) => [n, meval(v)])) },
    f: { headline_model: "ensemble", calls: call, models: Object.fromEntries(names.map((n, i) => [n, fc(t, 0.5 + i * 0.01, extra)])) },
  };
}
function data(): PredictionSummary {
  const a = hz("2026-10-29", "better", calls("promising")), b = hz("2026-11-04", "no_difference", calls("no_edge_shown"));
  return {
    ready: true, generated_at: "2026-10-28T15:30:00Z", computed_at: "2026-10-28T15:30:00Z", model_version: "3",
    features: { T1: { version: "t1-v1", names: ["spx_ret", "brent_ret"] }, T5: { version: "t5-v1", names: ["nifty_ret_5d"], flows: [] } },
    data: { symbol: "NIFTY 50", bars: 4689, first: "2007-09-17", last: "2026-10-28", reference_close: 22698.85, up_rate_all: { T1: 0.53 }, overnight_data_fresh: true, stale_series: [] },
    evaluation: { initial_train: 1000, test_size: 250, scheme: "expanding window", horizons: { T1: a.ev, T5: b.ev, T5F: { available: false, reason: "NSE participant history is too short so far" } } },
    forecasts: { T1: a.f, T5: b.f }, excluded_inputs: ["news"],
    ledger: { counts: {}, recent: { T1: [{ forecast_id: "a", model: "ensemble", model_version: "3", reference_session: "2026-10-28", target_session: "2026-10-29", generated_at: "x", p_up_model: 0.536, p_up_climatology: 0.528, intact: true, outcome: null }], T5: [] } },
  };
}
function mount(body: PredictionSummary | null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0]!;
    const map: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [summary()], "/api/prediction/summary": body };
    return map[url] == null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(map[url]), { status: 200 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/prediction"]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("Prediction page", () => {
  it("shows both models separately, the call banner, calls statistics and a verdict per model", async () => {
    mount(data());
    const t1 = await screen.findByTestId("forecast-T1");
    expect(within(t1).getByText(/Target: 2026-10-29/)).toBeInTheDocument();
    expect(within(t1).getByTestId("call-T1")).toHaveTextContent("No call");
    for (const n of names) expect(screen.getByTestId(`chip-T1-${n}`)).toBeInTheDocument();
    expect(within(t1).getAllByText("Edge confirmed").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("forecast-T5")).getAllByText("No edge shown").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("perf-T1")).getByTestId("calls-stats")).toHaveTextContent("714 of 1750");
    expect(within(screen.getByTestId("perf-T1")).getByText(/Calls beat always-up/)).toBeInTheDocument();
    expect(screen.getByTestId("perf-T5F-na")).toHaveTextContent("too short");
    expect(screen.getByRole("table", { name: "Ledger T1" })).toBeInTheDocument();
    expect(screen.getByText(/not trading advice/i)).toBeInTheDocument();
  });
  it("marks a preview clearly when the overnight data is not in yet", async () => {
    const d = data();
    if (d.ready) for (const m of Object.values(d.forecasts.T1.models)) Object.assign(m, { recorded: false, preview: true, reason: "preview: overnight bars not yet in for SPX" });
    mount(d);
    expect(await screen.findByTestId("preview-T1")).toHaveTextContent("not yet in for SPX");
  });
  it("selecting a model in the comparison shows its reliability table", async () => {
    mount(data());
    const table = await screen.findByRole("table", { name: "Metrics T1" });
    within(table).getByText("boost all").click();
    expect(await screen.findAllByText(/boost all: desc/)).not.toHaveLength(0);
  });
  it("says so plainly while computing", async () => {
    mount({ ready: false, computing: true, reason: "Training and evaluating models" });
    expect(await screen.findByTestId("not-ready")).toHaveTextContent("Training and evaluating");
  });
  it("shows an error, not a placeholder, when the backend lacks the module", async () => {
    mount(null);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not available/);
  });
});
