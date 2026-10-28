import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { bigChain, expiries, status, streamStatus } from "./fixtures";
import { liveStore } from "../lib/liveStore";
import type { HistoryResponse, Observation, OiChange, OiHeatmap, SamplerStatus } from "../lib/types";

// jsdom has no canvas: the chart wrapper is replaced by a stub that exposes the option it was given.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel, onClick }: { option: unknown; ariaLabel: string; onClick?: (p: { name: string }) => void }) => {
    const o = option as { series?: { name?: string; data: unknown[] }[]; xAxis?: { data?: string[] } };
    return (
      <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((s) => s.name ?? "").join("|")}
        data-points={(o.series ?? []).map((s) => s.data.length).join(",")}>
        {o.xAxis?.data?.slice(0, 40).map((x) => (
          <button key={x} type="button" aria-label={`bar ${x}`} onClick={() => onClick?.({ name: x })} />
        ))}
      </div>
    );
  },
}));

class RO { observe() {} unobserve() {} disconnect() {} }

function obs(i: number, over: Partial<Observation> = {}): Observation {
  return {
    snapshot_id: `s${i}`, retrieved_at: `2026-10-28T0${i}:00:00Z`, session_id: "x", underlying_ltp: 24050,
    underlying_prev_close: 24100, atm_strike: 24050, atm_call_ltp: 100, atm_put_ltp: 100, straddle: 200,
    total_ce_premium: 700, total_pe_premium: 700, total_ce_oi: 7000, total_pe_oi: 7000, total_ce_volume: 70,
    total_pe_volume: 70, strikes_in_universe: 7, missing_ltp: 0, same_as_previous: i > 1, ...over,
  };
}

function history(observations: Observation[], distinct: number): HistoryResponse {
  return { underlying: "NIFTY", expiry: "2026-11-03", strikes_each_side: 10, observations, distinct_observations: distinct,
    definitions: { straddle: "ATM call LTP + ATM put LTP" }, note: "" };
}

function sampler(over: Partial<SamplerStatus> = {}): SamplerStatus {
  return { enabled: true, interval_seconds: 60, session: "09:15–15:30 IST, Mon–Fri", state: "waiting",
    reason: "outside 09:15–15:30 IST", in_session: false, last_attempt_at: null, last_success_at: null,
    last_error: null, next_due_at: null, samples_this_run: 0, skipped_unchanged: 0,
    free_disk_gb: 50, ...over };
}

function mockApi(hist: HistoryResponse, extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": expiries, "/api/snapshots": [], "/api/sessions": [],
    "/api/option-chain": bigChain(), "/api/history/observations": hist, ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    if (typeof hit === "function") return new Response(JSON.stringify((hit as (u: string) => unknown)(String(input))), { status: 200, headers: { "Content-Type": "application/json" } });
    if (hit === undefined) return new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function renderAnalysis() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/analysis"]}><AppRoutes /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  localStorage.clear();
  liveStore.reset();
});
afterEach(() => vi.unstubAllGlobals());

const widget = (name: string) => screen.findByRole("region", { name });

describe("analysis dashboard", () => {
  it("builds the default widgets from the stored snapshot", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    for (const t of ["Open interest by strike", "OI change by strike", "Option chain", "Total premium", "Premium decay", "Key levels"])
      expect(await widget(t)).toBeInTheDocument();
    const oi = await screen.findByRole("img", { name: "Open interest by strike" });
    expect(oi.dataset.series).toBe("Calls (CE)|Puts (PE)");
    expect(oi.dataset.points).toBe("7,7");
    expect(document.body.textContent).not.toMatch(/demo|synthetic|mock/i);
  });

  it("labels every widget with its source and expiry", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    const oi = await widget("Open interest by strike");
    expect(await within(oi).findByText("Snapshot")).toBeInTheDocument();
    expect(within(oi).getByText(/03 Nov|3 Nov/)).toBeInTheDocument();
    const prem = await widget("Total premium");
    expect(await within(prem).findByText("Stored (historical)")).toBeInTheDocument();
  });

  it("explains a flat time series instead of presenting it as movement", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    const prem = await widget("Total premium");
    expect(await within(prem).findByText(/identical values/)).toBeInTheDocument();
  });

  it("refuses to draw a line from fewer than two snapshots", async () => {
    mockApi(history([obs(1)], 1));
    renderAnalysis();
    const prem = await widget("Total premium");
    expect(await within(prem).findByText(/Not enough stored snapshots/)).toBeInTheDocument();
    expect(within(prem).queryByRole("img")).toBeNull();
  });

  it("draws the time series when snapshots differ", async () => {
    mockApi(history([obs(1), obs(2, { total_ce_premium: 650, same_as_previous: false })], 2));
    renderAnalysis();
    const prem = await widget("Total premium");
    const chart = await within(prem).findByRole("img");
    expect(chart.dataset.points).toBe("2,2");
    expect(within(prem).queryByText(/identical values/)).toBeNull();
  });

  it("hides calls or puts from every chart with the toggles", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    await widget("Open interest by strike");
    await userEvent.click(screen.getByRole("checkbox", { name: "Calls" }));
    expect((await screen.findByRole("img", { name: "Open interest by strike" })).dataset.series).toBe("Puts (PE)");
    expect(screen.getByRole("img", { name: "Total premium over stored snapshots" }).dataset.series).toBe("PE total premium");
  });

  it("selecting a strike from a chart bar shows it in the strike detail widget", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    await widget("Open interest by strike");
    await userEvent.click(screen.getByRole("button", { name: /Add widget/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Strike detail" }));
    const detail = await widget("Strike detail");
    expect(within(detail).getByText("No strike selected")).toBeInTheDocument();
    await userEvent.click(within(await widget("Open interest by strike")).getByRole("button", { name: "bar 24100" }));
    await waitFor(() => expect(within(detail).getByText("24,100")).toBeInTheDocument());
    expect(within(detail).getByText("Call (CE)")).toBeInTheDocument();
  });

  it("key levels come from the same rows: totals, PCR and max pain", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    const lv = await widget("Key levels");
    await waitFor(() => expect(within(lv).getByText("PCR (OI)").nextSibling).toHaveTextContent("1.00"));
    expect(within(lv).getByText("Total call OI").nextSibling).toHaveTextContent("7.0 K");
    expect(within(lv).getByText("ATM strike").nextSibling).toHaveTextContent("24,050");
  });

  it("removes a widget, adds it back, and resets the layout", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    await widget("Premium decay");
    await userEvent.click(screen.getByRole("button", { name: "Remove Premium decay" }));
    expect(screen.queryByRole("region", { name: "Premium decay" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Add widget/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Premium decay" }));
    expect(await widget("Premium decay")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove Key levels" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(await widget("Key levels")).toBeInTheDocument();
  });

  it("remembers removed widgets across visits", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    const first = renderAnalysis();
    await widget("Premium decay");
    await userEvent.click(screen.getByRole("button", { name: "Remove Premium decay" }));
    await waitFor(() => expect(localStorage.getItem("nse.analysis.layout.v1")).not.toContain("decay"));
    first.unmount();
    renderAnalysis();
    await widget("Key levels");
    expect(screen.queryByRole("region", { name: "Premium decay" })).toBeNull();
  });

  it("survives unreadable saved layout", async () => {
    localStorage.setItem("nse.analysis.layout.v1", "{not json");
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    expect(await widget("Key levels")).toBeInTheDocument();
  });

  it("offers to fetch a snapshot when none is stored for the expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split("?")[0]!;
      if (url === "/api/option-chain")
        return new Response(JSON.stringify({ detail: { code: "no_snapshot", message: "none" } }), { status: 404 });
      const map: Record<string, unknown> = {
        "/api/status": status(), "/api/expiries": expiries, "/api/history/observations": history([], 0),
      };
      return map[url] === undefined
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify(map[url]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderAnalysis();
    expect((await screen.findAllByText("No snapshot stored for this expiry")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Fetch snapshot" })[0]).toBeEnabled();
  });

  it("while streaming, widgets show live values and say so", async () => {
    mockApi(history([obs(1), obs(2)], 1), {
      "/api/status": status({ stream: streamStatus({ state: "streaming", effective_state: "streaming", freshness: "fresh" }) }),
    });
    renderAnalysis();
    const oi = await widget("Open interest by strike");
    await waitFor(() => expect(within(oi).getByText("Live")).toBeInTheDocument());
    await act(async () => { /* settle throttled updates */ });
  });

  it("tells the user when sampling runs and why it is waiting", async () => {
    mockApi(history([obs(1), obs(2)], 1), { "/api/sampler/status": sampler() });
    renderAnalysis();
    const note = await screen.findByTestId("sampler-note");
    expect(note).toHaveTextContent("Sampling every 60 s during 09:15–15:30 IST");
    expect(note).toHaveTextContent("Waiting: outside 09:15–15:30 IST");
  });

  it("shows sampling failures instead of hiding them", async () => {
    mockApi(history([obs(1), obs(2)], 1), {
      "/api/sampler/status": sampler({ state: "error", in_session: true, reason: "", last_error: "BrokerError: rate limited" }),
    });
    renderAnalysis();
    expect(await screen.findByTestId("sampler-note")).toHaveTextContent("last attempt failed: BrokerError: rate limited");
  });

  it("reports a running sampler and says when it is disabled", async () => {
    mockApi(history([obs(1), obs(2)], 1), {
      "/api/sampler/status": sampler({ state: "waiting", in_session: true, reason: "", last_success_at: "2026-10-28T05:00:00Z", samples_this_run: 4 }),
    });
    const first = renderAnalysis();
    const note = await screen.findByTestId("sampler-note");
    expect(note).toHaveTextContent("Sampling every 60 s now");
    expect(note).toHaveTextContent("4 this run");
    first.unmount();
    mockApi(history([obs(1), obs(2)], 1), { "/api/sampler/status": sampler({ enabled: false, state: "off" }) });
    renderAnalysis();
    expect(await screen.findByTestId("sampler-note")).toHaveTextContent("turned off");
  });

  it("shows nothing about sampling when the backend does not have it yet", async () => {
    mockApi(history([obs(1), obs(2)], 1));
    renderAnalysis();
    await widget("Key levels");
    expect(screen.queryByTestId("sampler-note")).toBeNull();
  });

  it("reports skipped repeats and warns about low disk space", async () => {
    mockApi(history([obs(1), obs(2)], 1), {
      "/api/sampler/status": sampler({ skipped_unchanged: 6, free_disk_gb: 1.4 }),
    });
    renderAnalysis();
    const note = await screen.findByTestId("sampler-note");
    expect(note).toHaveTextContent("6 unchanged chains not re-stored");
    expect(note).toHaveTextContent("Disk: 1.4 GB free");
  });
});

function oiRes(over: Partial<OiChange> = {}): OiChange {
  const row = (strike: number, side: "CE" | "PE", oi: number, base: number | null, ltp: number, bl: number | null) => ({
    strike, side, oi, baseline_oi: base, change: base == null ? null : oi - base,
    change_pct: base ? ((oi - base) / base) * 100 : null,
    label: base == null ? "Insufficient data" : oi > base ? "OI increased" : oi < base ? "OI decreased" : "OI unchanged",
    ltp, baseline_ltp: bl, price_change: bl == null ? null : ltp - bl, price_change_pct: null,
    relation: base == null || bl == null ? null : `OI ${oi > base ? "up" : oi < base ? "down" : "flat"}, premium ${ltp > bl ? "up" : ltp < bl ? "down" : "flat"}`,
  });
  return {
    underlying: "NIFTY", expiry: "2026-11-03",
    baseline: { kind: "session_open", label: "First observation of the session", at: "2026-10-28T03:45:00Z", note: "" },
    current_at: "2026-10-28T04:45:00Z", spot: 24050, baseline_spot: 24030, underlying_change: 20, atm_strike: 24050,
    strikes_each_side: 10,
    rows: [row(24050, "CE", 160, 100, 120, 100), row(24050, "PE", 90, 120, 80, 100), row(24100, "CE", 50, null, 60, null)],
    totals: { ce_oi: 210, pe_oi: 90, ce_change: 60, pe_change: -30 },
    concentration: [
      { strike: 24050, side: "CE", oi: 160, share_pct: 76.2, baseline_share_pct: 100, share_change_pts: -23.8 },
      { strike: 24100, side: "CE", oi: 50, share_pct: 23.8, baseline_share_pct: 23.8, share_change_pts: -0.01 },
    ],
    observations_available: 3, warnings: [],
    definitions: { relation: "Direction of OI and of the option premium between the same two observations." }, ...over,
  };
}
const hmRes = (over: Partial<OiHeatmap> = {}): OiHeatmap => ({
  underlying: "NIFTY", expiry: "2026-11-03", side: "CE",
  baseline: { kind: "session_open", label: "First observation of the session", at: "2026-10-28T03:45:00Z", note: "" },
  strikes: [24000, 24050], times: ["2026-10-28T03:45:00Z", "2026-10-28T04:45:00Z"], change: [[0, 5], [0, null]],
  stride: 1, atm_strike: 24050, missing_cells: 1, warnings: [], ...over,
});

describe("OI intelligence widgets", () => {
  async function open(ids: string[], routes: Record<string, unknown>) {
    localStorage.setItem("nse.analysis.layout.v1", JSON.stringify({ active: ids, layout: ids.map((id, i) => ({ i: id, x: 0, y: i * 12, w: 12, h: 12 })) }));
    mockApi(history([obs(1), obs(2)], 1), routes);
    renderAnalysis();
  }

  it("shows OI change against an explicit baseline with its timestamps and neutral labels", async () => {
    await open(["oiIntraday"], { "/api/oi/change": () => oiRes() });
    const w = await widget("Intraday OI change");
    const sum = await within(w).findByTestId("oi-summary");
    expect(sum).toHaveTextContent("First observation of the session");
    expect(sum).toHaveTextContent("calls +");
    expect(sum).toHaveTextContent("puts −");
    const chart = within(w).getByRole("img");
    expect(chart.dataset.series).toBe("Calls (CE)|Puts (PE)");
    expect(document.body.textContent).not.toMatch(/bullish|bearish|support|resistance|writing|long buildup|short buildup/i);
  });

  it("changing the baseline asks the backend for that baseline", async () => {
    const urls: string[] = [];
    await open(["oiIntraday"], { "/api/oi/change": (u: string) => { urls.push(u); return oiRes(); } });
    const w = await widget("Intraday OI change");
    await within(w).findByTestId("oi-summary");
    await userEvent.selectOptions(within(w).getByLabelText("OI baseline"), "prev_session");
    await waitFor(() => expect(urls.some((u) => u.includes("baseline=prev_session"))).toBe(true));
    await userEvent.selectOptions(within(w).getByLabelText("OI baseline"), "at");
    expect(await within(w).findByText("Choose a baseline time.")).toBeInTheDocument();
    await userEvent.type(within(w).getByLabelText("Baseline time (IST)"), "2026-10-28T10:00");
    await waitFor(() => expect(urls.some((u) => u.includes("baseline=at") && u.includes("at=2026-10-28T10%3A00%3A00%2B05%3A30"))).toBe(true));
  });

  it("says so when no baseline exists, instead of drawing zeros", async () => {
    const none = oiRes({ rows: oiRes().rows.map((r) => ({ ...r, baseline_oi: null, change: null, label: "Insufficient data", relation: null })),
      baseline: { kind: "previous", label: "Previous distinct observation", at: null, note: "No earlier observation with different values is stored." },
      warnings: ["No earlier observation with different values is stored."] });
    await open(["oiIntraday"], { "/api/oi/change": () => none });
    const w = await widget("Intraday OI change");
    expect(await within(w).findByText("No comparable baseline")).toBeInTheDocument();
    expect(within(w).queryByRole("img")).toBeNull();
  });

  it("explains an empty observation store", async () => {
    await open(["oiConcentration"], { "/api/oi/change": () => oiRes({ rows: [], observations_available: 0 }) });
    const w = await widget("OI concentration");
    expect(await within(w).findByText("No observations stored for this expiry yet")).toBeInTheDocument();
  });

  it("concentration is shown as share, with no support or resistance claim", async () => {
    await open(["oiConcentration"], { "/api/oi/change": () => oiRes() });
    const w = await widget("OI concentration");
    const t = await within(w).findByRole("table", { name: "OI concentration" });
    expect(within(t).getByText("76.2%")).toBeInTheDocument();
    expect(within(t).getByText("−23.8 pts")).toBeInTheDocument();
    expect(within(t).getByText("0.0 pts")).toBeInTheDocument(); // rounds to zero: no minus sign
    expect(w.textContent).toMatch(/not support or resistance/);
  });

  it("price and OI table lists the observed relation and skips rows with no baseline", async () => {
    await open(["priceOi"], { "/api/oi/change": () => oiRes() });
    const w = await widget("Price and OI");
    const t = await within(w).findByRole("table", { name: "Price and OI" });
    expect(within(t).getByText("OI up, premium up")).toBeInTheDocument(); // CE: 160 vs 100, 120 vs 100
    expect(within(t).getByText("OI down, premium down")).toBeInTheDocument(); // PE: 90 vs 120, 80 vs 100
    expect(within(t).queryByText("24,100 CE")).toBeNull(); // no baseline: not listed
  });

  it("heatmap shows its baseline, the missing-cell count and the chosen side", async () => {
    const urls: string[] = [];
    await open(["oiHeatmap"], { "/api/oi/heatmap": (u: string) => { urls.push(u); return hmRes(); } });
    const w = await widget("OI change heatmap");
    const note = await within(w).findByTestId("heatmap-note");
    expect(note).toHaveTextContent("First observation of the session");
    expect(note).toHaveTextContent("1 cells");
    expect(within(w).getByRole("img").dataset.points).toBe("3"); // 4 cells, one missing
    await userEvent.click(within(w).getByRole("button", { name: "Puts" }));
    await waitFor(() => expect(urls.some((u) => u.includes("side=PE"))).toBe(true));
  });

  it("heatmap with one observation says a grid needs two", async () => {
    await open(["oiHeatmap"], { "/api/oi/heatmap": () => hmRes({ times: ["2026-10-28T03:45:00Z"], change: [[0], [0]], missing_cells: 0 }) });
    const w = await widget("OI change heatmap");
    expect(await within(w).findByText("Only one observation so far")).toBeInTheDocument();
  });
});
