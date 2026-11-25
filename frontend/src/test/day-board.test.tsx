// The Market Intelligence day board: sentiment through the day, the phases, the expected outcome and the track record. Built from the real stored minutes of 23 Nov 2026
// (the outlook the backend builds from them), so the figures on screen are the ones the server computes.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayBoard } from "../components/intelligence/DayBoard";
import { classOf, dayBoardChart, horizonName } from "../lib/dayBoard";
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
    expect(screen.getByRole("alert")).toHaveTextContent("The rest of the page below does not depend on it");
  });
});
