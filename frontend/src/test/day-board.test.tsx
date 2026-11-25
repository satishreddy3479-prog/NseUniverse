// The Market Intelligence day board: sentiment through the day, the phases, the expected outcome and the track record. Built from the real stored minutes of 23 Nov 2026
// (the outlook the backend builds from them), so the figures on screen are the ones the server computes.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayBoard } from "../components/intelligence/DayBoard";
import { applyLiveSpot, classOf, dayBoardChart, horizonName, sigmaPoints } from "../lib/dayBoard";
import type { Outlook } from "../lib/intelligence";
import closedJson from "./outlook-closed.json";
import liveJson from "./outlook-live.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: { series?: { name?: string }[] } }) => <div role="img" aria-label={ariaLabel} data-series={(option.series ?? []).map((s) => s.name).join("|")} />,
}));

const closed = closedJson as unknown as Outlook;
const live = liveJson as unknown as Outlook;
const colors = { up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" } as never;

function mount(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DayBoard /></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("the day chart", () => {
  it("has the index, the fused sentiment with the trend group, and the evidence quality on one time axis, with the verdict zones named", () => {
    const { option, height } = dayBoardChart(colors, live);
    const names = (option.series as { name: string }[]).map((s) => s.name).filter((n) => !n.startsWith("__"));
    expect(names).toEqual(["NIFTY", "Sentiment", "Trend & regime group", "Evidence quality"]);
    const series = option.series as { name: string; data: (number | null)[] }[];
    expect(series.find((s) => s.name === "NIFTY")!.data).toHaveLength(live.path.length);
    expect(series.find((s) => s.name === "Sentiment")!.data[0]).toBe(live.path[0]!.score);
    expect(height).toBeGreaterThan(300);
    const marks = series.filter((s) => s.name.startsWith("__panel")) as unknown as { markArea: { data: unknown[][] }; markLine?: { data: { yAxis: number }[] } }[];
    expect(marks[1]!.markLine!.data.map((d) => d.yAxis)).toEqual([0, 15, -15, 35, -35]); // the neutral band and the verdict thresholds
    expect(marks[1]!.markArea.data).toHaveLength(3); // bullish, bearish and neutral zones; no regime shading yet (these minutes carry no trend label)
  });

  it("shades the trend regime behind every panel once the minutes carry it", () => {
    const withLabels: Outlook = { ...live, path: live.path.map((p, i) => ({ ...p, trend_label: i < 60 ? "Warming up" : i < 120 ? "Trending down" : "Mixed" })) };
    const { option } = dayBoardChart(colors, withLabels);
    const panel0 = (option.series as { name: string; markArea?: { data: unknown[] } }[]).find((s) => s.name === "__panel0")!;
    expect(panel0.markArea!.data).toHaveLength(2); // the warm-up is left unshaded: Trending down, then Mixed
  });

  it("names a score's class by the backend's cut-offs and the horizon of the close in hours", () => {
    expect([classOf(70), classOf(35), classOf(15), classOf(14.9), classOf(-15), classOf(-35), classOf(-70), classOf(null)]).toEqual(["Strong Bullish", "Bullish", "Mild Bullish", "Neutral", "Mild Bearish", "Bearish", "Strong Bearish", "—"]);
    expect(horizonName("To the close", 210)).toBe("To the close (3 h 30 min)");
    expect(horizonName("To the close", 45)).toBe("To the close (45 min)");
    expect(horizonName("Next 30 minutes", 30)).toBe("Next 30 minutes");
  });
});

describe("the day board while the market is live", () => {
  it("answers in four tiles, reads the evidence in sentences and prices the next 30 minutes at the implied move", async () => {
    mount(live);
    const header = await screen.findByTestId("day-header");
    expect(within(header).getByText(/Sentiment now/)).toBeInTheDocument();
    expect(header).toHaveTextContent(`${live.now.class} (`);
    expect(header).toHaveTextContent("Trending down");
    expect(header).toHaveTextContent("trend score 88/100 · 4 of 4 readings agree");
    expect(header).toHaveTextContent("leans down");
    expect(header).toHaveTextContent("±77 pts"); // 25,528 x 16.92 % x sqrt(30 / 94,500)
    expect(screen.queryByTestId("day-closed")).toBeNull();
    expect(screen.getByTestId("day-read")).toHaveTextContent("Sentiment is");
    const chart = screen.getByRole("img", { name: /fused sentiment/ });
    expect(chart.getAttribute("data-series")).toContain("Sentiment");
    expect(chart.getAttribute("data-series")).toContain("Evidence quality");
  });

  it("shows the five phases: finished ones with their verdict and move, the running one and the ones to come priced", async () => {
    mount(live);
    const phases = await screen.findByTestId("day-phases");
    expect(within(phases).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByTestId("phase-Opening hour")).toHaveTextContent("done");
    expect(screen.getByTestId("phase-Opening hour")).toHaveTextContent("NIFTY −");
    expect(screen.getByTestId("phase-Midday")).toHaveTextContent("now");
    expect(screen.getByTestId("phase-Closing")).toHaveTextContent("to come");
    expect(screen.getByTestId("phase-Closing")).toHaveTextContent(/priced at about ±\d+ pts/);
  });

  it("lists the priced move and band for each horizon, the history after the same verdict, and the levels nearest first", async () => {
    mount(live);
    const e30 = await screen.findByTestId("expected-30");
    expect(e30).toHaveTextContent("±77 pts");
    expect(e30).toHaveTextContent("25,451.80 – 25,605.80");
    expect(screen.getByTestId("expected-15")).toHaveTextContent("±54 pts"); // 77.0 / sqrt(2)
    expect(screen.getByTestId("day-expected")).toHaveTextContent("says nothing about direction");
    const levels = within(screen.getByTestId("day-levels")).getAllByRole("listitem");
    expect(levels.length).toBeGreaterThanOrEqual(4);
    const dist = levels.map((l) => Math.abs(Number(/([−+]\d+) pts/.exec(l.textContent ?? "")?.[1]?.replace("−", "-") ?? "NaN")));
    expect(dist).toEqual([...dist].sort((a, b) => a - b)); // nearest first
  });

  it("grades the record honestly: early evidence over six sessions, with every session's rate, and today's scorecard", async () => {
    mount(live);
    expect(await screen.findByTestId("day-grade")).toHaveTextContent("Early");
    const rec = screen.getByTestId("day-record");
    expect(rec).toHaveTextContent("early evidence, not an established record");
    expect(within(rec).getAllByTitle(/decided calls/)).toHaveLength(6); // one chip per test session
    expect(screen.getByTestId("day-score")).toHaveTextContent(/Today so far: \d+ of \d+ decided 30-minute calls were right/);
    expect(screen.getByTestId("day-history")).toHaveTextContent("Sessions");
    expect(screen.getByTestId("day-history")).toHaveTextContent("(now)"); // the current verdict class is marked in the table
    expect(screen.getByTestId("day-limits")).toHaveTextContent("not a forecast");
  });
});

describe("the day board when the market is closed, empty or unreachable", () => {
  it("says the market is not live, shows the recorded session and prices nothing ahead", async () => {
    mount(closed);
    expect(await screen.findByTestId("day-closed")).toHaveTextContent("Showing the recorded session of 2026-11-23");
    expect(screen.getByTestId("day-header")).toHaveTextContent("Market closed");
    expect(screen.getByTestId("expected-30")).toHaveTextContent("—");
  });

  it("explains an empty session instead of drawing an empty chart", async () => {
    mount({ ...closed, path: [], scorecard: { ...closed.scorecard, rows: [], hits: 0, misses: 0, decided: 0 } });
    expect(await screen.findByTestId("day-chart-empty")).toHaveTextContent("No minutes have been recorded for 2026-11-23 yet");
    expect(screen.getByTestId("day-record")).toHaveTextContent("No calls recorded yet");
  });

  it("with no verdict (too few groups) says so and shows the reason, not a neutral score", async () => {
    mount({ ...live, now: { ...live.now, score: null, class: "INSUFFICIENT DATA", confidence: null, reason: "2 engines available (need 3)", lean: { call: 0, text: "no verdict: not enough evidence", why: "insufficient data" } } });
    const header = await screen.findByTestId("day-header");
    expect(header).toHaveTextContent("No verdict");
    expect(header).toHaveTextContent("2 engines available (need 3)");
  });

  it("an unreachable server shows an error that says the rest of the page does not depend on it", async () => {
    mount({ detail: "x" }, 500);
    await waitFor(() => expect(screen.getByTestId("day-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("The evidence below does not depend on it");
  });
});

describe("provenance and staleness", () => {
  it("a closed page labels its verdict as the last recorded minute and does not price the close", async () => {
    mount(closed);
    expect(await screen.findByText("Sentiment at the last recorded minute")).toBeInTheDocument();
    expect(screen.queryByText(/To the close/)).toBeNull();
  });

  it("warns when the newest recorded minute is old while the market is live", async () => {
    mount({ ...live, lag_minutes: 8, last_recorded_at: live.path[live.path.length - 1]!.at });
    expect(await screen.findByTestId("day-lag")).toHaveTextContent("8 minutes old");
    expect(screen.getByTestId("day-lag")).toHaveTextContent("tiles above read the live data");
  });

  it("shows no lag warning when the record is current", async () => {
    mount({ ...live, lag_minutes: 1 });
    await screen.findByTestId("day-header");
    expect(screen.queryByTestId("day-lag")).toBeNull();
  });
});

describe("the live tick over the outlook", () => {
  const at = Date.parse(live.path[live.path.length - 1]!.at) + 3 * 60_000; // three minutes after the last recorded minute

  it("re-prices the bands from the tick with the server's implied volatility: spot x IV x sqrt(minutes / 94,500)", () => {
    const o = applyLiveSpot(live, { ltp: 25400, at });
    const e30 = o.expected.find((e) => e.minutes === 30)!;
    // 25,400 x 16.92 % x sqrt(30 / 94,500) = 4297.68 x 0.017817 = 76.57
    expect(e30.sd_points).toBeCloseTo(76.6, 1);
    expect(e30.low).toBeCloseTo(25400 - 76.6, 1);
    expect(e30.high).toBeCloseTo(25400 + 76.6, 1);
    expect(sigmaPoints(25400, 16.92, 30)).toBeCloseTo(76.57, 1);
    expect(sigmaPoints(null, 16.92, 30)).toBeNull();
  });

  it("measures the levels from the tick, nearest first, and appends the tick as the chart's last point with no verdict", () => {
    const o = applyLiveSpot(live, { ltp: 25400, at });
    const l0 = o.levels[0]!;
    expect(l0.distance_points).toBeCloseTo(l0.price - 25400, 1);
    const d = o.levels.map((l) => Math.abs(l.distance_points ?? 1e9));
    expect(d).toEqual([...d].sort((a, b) => a - b));
    const last = o.path[o.path.length - 1]!;
    expect(o.path).toHaveLength(live.path.length + 1);
    expect(last.spot).toBe(25400);
    expect(last.score).toBeNull(); // the tick has a price, not a verdict
    expect(o.path[o.path.length - 2]).toEqual(live.path[live.path.length - 1]);
  });

  it("replaces the price of the recorded minute when the tick is in the same minute, and changes nothing when the market is closed or there is no tick", () => {
    const sameMinute = Date.parse(live.path[live.path.length - 1]!.at) + 20_000;
    const o = applyLiveSpot(live, { ltp: 25410, at: sameMinute });
    expect(o.path).toHaveLength(live.path.length);
    expect(o.path[o.path.length - 1]!.spot).toBe(25410);
    expect(o.path[o.path.length - 1]!.score).toBe(live.path[live.path.length - 1]!.score); // the recorded verdict stays
    expect(applyLiveSpot(closed, { ltp: 25400, at })).toBe(closed);
    expect(applyLiveSpot(live, null)).toBe(live);
  });
});
