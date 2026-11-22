// The gamma map and sudden-move panel of the Greeks page, rendered against real engine output (fixture: the server's own answer for a stored synthetic session).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GammaMapPanel } from "../components/risk/GammaMapPanel";
import { crore, profileOption, type GammaMap } from "../lib/gammaMap";
import fx from "./fixtures/risk/gamma_map.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: unknown }) => <div role="img" aria-label={ariaLabel} data-option={JSON.stringify(option)} />,
}));

const base = fx as unknown as GammaMap;
const EXP = base.expiry;
let urls: string[] = [];

function install(body: unknown, status = 200) {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}
function mount(expiries: string[] = [EXP]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><GammaMapPanel expiries={expiries} /></QueryClientProvider>);
}
const optionOf = (label: string | RegExp) => JSON.parse(screen.getByRole("img", { name: label }).getAttribute("data-option") ?? "{}") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
afterEach(() => { vi.unstubAllGlobals(); });

describe("gamma map and sudden-move risk", () => {
  it("shows the score, level and every component exactly as the server computed them", async () => {
    install(base);
    mount();
    expect(await screen.findByTestId("gamma-blast-score")).toHaveTextContent(String(Math.round(base.blast!.score!)));
    expect(screen.getByTestId("gamma-blast-level")).toHaveTextContent("Building"); // 26.3 is in the 25 to 50 band
    expect(screen.getByTestId("gamma-blast")).toHaveTextContent(`${base.blast!.coverage_pct}% of the inputs available`);
    for (const c of base.blast!.components) {
      const row = screen.getByTestId(`gamma-comp-${c.key}`);
      expect(row).toHaveTextContent(c.label);
      expect(row).toHaveTextContent(c.value == null ? "—" : `${Math.round(c.value * 100)}%`); // a missing input is a dash, never 0%
    }
    expect(urls[0]).toBe(`/api/intraday/gamma-map?expiry=${EXP}&universe=dynamic`);
  });

  it("asks for the full chain when chosen and for the other expiry when picked", async () => {
    install(base);
    mount([EXP, "2026-12-01"]);
    await screen.findByTestId("gamma-blast");
    fireEvent.change(screen.getByTestId("gamma-universe"), { target: { value: "full" } });
    await waitFor(() => expect(urls.at(-1)).toBe(`/api/intraday/gamma-map?expiry=${EXP}&universe=full`));
    fireEvent.change(screen.getByTestId("gamma-expiry"), { target: { value: "2026-12-01" } });
    await waitFor(() => expect(urls.at(-1)).toBe("/api/intraday/gamma-map?expiry=2026-12-01&universe=full"));
  });

  it("shows the since-open average, range, near-the-money net, time short and the flip with its distance from spot", async () => {
    install(base);
    mount();
    const t = await screen.findByTestId("gamma-average");
    const a = base.average!.abs!;
    expect(t).toHaveTextContent(`Absolute gamma now${a.now.toFixed(0)}`);
    expect(t).toHaveTextContent(`average ${a.mean.toFixed(0)} · ${a.now_vs_mean!.toFixed(2)}×`);
    expect(t).toHaveTextContent(`${a.min.toFixed(0)} – ${a.max.toFixed(0)}`);
    expect(t).toHaveTextContent(`Time short gamma${Math.round(base.average!.negative_share! * 100)}%`);
    const last = base.points.at(-1)!;
    const dist = ((last.spot - last.flip!) / last.spot) * 100;
    expect(within(t).getByText(`NIFTY ${dist >= 0 ? "above" : "below"} by ${Math.abs(dist).toFixed(2)}%`)).toBeInTheDocument();
  });

  it("draws the strike profile with the call, put and net values of the fixture and marks the strikes nearest spot and the flip", async () => {
    install(base);
    mount();
    await screen.findByTestId("gamma-blast");
    const o = optionOf(/Gamma exposure by strike/);
    expect(o.xAxis.data).toEqual(base.profile.map((r) => String(r.strike)));
    expect(o.series[0].data).toEqual(base.profile.map((r) => r.ce));
    expect(o.series[1].data).toEqual(base.profile.map((r) => r.pe));
    const nearest = (v: number) => base.profile.reduce((b, r) => (Math.abs(r.strike - v) < Math.abs(b.strike - v) ? r : b)).strike;
    const marks = o.series[0].markLine.data as { xAxis: string; name: string }[];
    expect(marks.find((m) => m.name === "spot")!.xAxis).toBe(String(nearest(base.spot!)));
    expect(marks.find((m) => m.name === "flip")!.xAxis).toBe(String(nearest(base.points.at(-1)!.flip!)));
  });

  it("keeps a missing snapshot value as a gap in the history chart, never a zero", async () => {
    const pts = base.points.map((p, i) => (i === 2 ? { ...p, near_net: null } : p));
    install({ ...base, points: pts });
    mount();
    await screen.findByTestId("gamma-blast");
    const o = optionOf(/Near-the-money net and absolute gamma/);
    const near = o.series.find((s: { name: string }) => s.name === "Near-the-money net").data as (number | null)[];
    expect(near[2] == null || (Array.isArray(near[2]) && near[2][1] == null)).toBe(true);
  });

  it("lists the sudden moves with their direction and the gamma before them, and flags a sudden latest step", async () => {
    const blast = { ...base.blast!, sudden: { typical_step_pct: 0.04, threshold_pct: 0.15, steps: 9, latest_is_sudden: true, events: [{ at: "2026-10-29T04:05:00+00:00", move: -60, pct: -0.25, direction: "down", near_net_before: -12, short_gamma_before: true }] } };
    install({ ...base, blast });
    mount();
    const ev = await screen.findByTestId("gamma-events");
    expect(ev).toHaveTextContent("down 60 points (−0.25%) · near-the-money gamma was short before it");
    expect(ev).toHaveTextContent("the larger of 0.15% and three times the typical step, 0.040%): 1");
    expect(screen.getByTestId("gamma-sudden-now")).toHaveTextContent("at least 0.15% of NIFTY");
  });

  it("says plainly when the score cannot be made, when there is no session, on an error and with no expiry", async () => {
    install({ ...base, blast: { status: "unavailable", message: "Fewer than two stored snapshots in this session.", score: null, level: null, components: [] } });
    const first = mount();
    expect(await screen.findByTestId("gamma-blast-unavailable")).toHaveTextContent("Fewer than two stored snapshots");
    first.unmount();
    install({ status: "no stored session", expiry: EXP, points: [], profile: [] });
    const second = mount();
    expect(await screen.findByTestId("gamma-unavailable")).toHaveTextContent("no stored session");
    second.unmount();
    install({}, 500);
    const third = mount();
    expect(await screen.findByTestId("gamma-error")).toHaveTextContent("could not be loaded (500)");
    third.unmount();
    mount([]);
    expect(screen.getByTestId("gamma-empty")).toBeInTheDocument();
  });

  it("states the assumptions: modelled exposure, sign convention, a sudden move and no direction", async () => {
    install(base);
    mount();
    const p = screen.getByTestId("gamma-map");
    expect(p).toHaveTextContent("an assumed sign convention, not observed dealer positions");
    expect(p).toHaveTextContent("never which way");
    expect(await screen.findByTestId("gamma-source")).toHaveTextContent(`Session ${base.session}`);
  });
});

describe("gamma map helpers", () => {
  it("formats crore with a real minus sign and a dash for missing", () => {
    expect(crore(-12.345)).toBe("−12.3");
    expect(crore(5)).toBe("+5.0");
    expect(crore(null)).toBe("—");
  });
  it("marks nothing when spot and flip are unknown", () => {
    const o = profileOption(base.profile, null, null, { up: "", down: "", brass: "", info: "", muted: "", rule: "", paper: "", slate: "" } as never) as { series: { markLine?: { data: unknown[] } }[] };
    expect(o.series[0]!.markLine!.data).toEqual([]);
  });
});
