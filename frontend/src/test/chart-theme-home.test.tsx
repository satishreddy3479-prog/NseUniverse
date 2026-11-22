// The shared chart look, the recent-pages list, the offline strip and the Home page.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineStrip } from "../components/OfflineStrip";
import { PALETTE_DARK, PALETTE_LIGHT, withChartTheme, type ThemeTokens } from "../lib/chartTheme";
import { loadRecent, rememberPage, RECENT_MAX } from "../lib/recent";
import { Home } from "../pages/Home";

const T: ThemeTokens = { dark: false, font: "IBM Plex Sans", muted: "#42516c", rule: "#d5dce9", paper: "#0a1530", slate: "#ffffff" };
type O = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("withChartTheme", () => {
  it("adds defaults and never overrides what the chart set", () => {
    const out = withChartTheme({
      tooltip: { trigger: "axis", backgroundColor: "#123456" },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#abcdef" } } },
      series: [{ type: "line", data: [1], lineStyle: { width: 1.2, color: "#ff0000" } }],
    } as O, T, 900) as O;
    expect(out.color).toEqual(PALETTE_LIGHT);
    expect(out.textStyle.fontFamily).toBe("IBM Plex Sans");
    expect(out.tooltip.backgroundColor).toBe("#123456"); // the chart's own colour wins
    expect(out.tooltip.borderColor).toBe(T.rule); expect(out.tooltip.textStyle.fontSize).toBe(12.5);
    expect(out.tooltip.axisPointer.type).toBe("line");
    expect(out.yAxis.splitLine.lineStyle.color).toBe("#abcdef"); // styled by the chart: only the dash is added
    expect(out.yAxis.splitLine.lineStyle.type).toBe("dashed");
    expect(out.series[0].lineStyle.width).toBe(1.2); // a thin line stays thin
    expect(out.series[0].itemStyle.color).toBe("#ff0000"); // the legend swatch takes the line colour
  });

  it("uses the night palette in the dark theme, and a line without a width gets 2", () => {
    const out = withChartTheme({ series: [{ type: "line", data: [1] }] } as O, { ...T, dark: true }, 900) as O;
    expect(out.color).toEqual(PALETTE_DARK);
    expect(out.series[0].lineStyle.width).toBe(2);
  });

  it("lifts axis, legend and label text under 12 px on a wide chart, leaves a narrow chart alone", () => {
    const opt = { legend: { textStyle: { fontSize: 11 } }, xAxis: { type: "category", axisLabel: { fontSize: 10 } }, yAxis: { type: "value", axisLabel: { fontSize: 11 } }, series: [{ type: "line", data: [1], markLine: { label: { fontSize: 10 } } }] } as O;
    const wide = withChartTheme(opt, T, 900) as O;
    expect(wide.legend.textStyle.fontSize).toBe(12); expect(wide.xAxis.axisLabel.fontSize).toBe(12); expect(wide.yAxis.axisLabel.fontSize).toBe(12);
    expect(wide.series[0].markLine.label.fontSize).toBe(12);
    const narrow = withChartTheme(opt, T, 400) as O;
    expect(narrow.xAxis.axisLabel.fontSize).toBe(10); expect(narrow.series[0].markLine.label.fontSize).toBe(10);
    expect(withChartTheme({ xAxis: { axisLabel: { fontSize: 14 } } } as O, T, 900).xAxis.axisLabel.fontSize).toBe(14); // larger is kept
  });

  it("rounds the end of each bar that is away from the axis: up for a positive vertical bar, down for a negative one, right and left for sideways bars", () => {
    const v = withChartTheme({ xAxis: { type: "category" }, yAxis: { type: "value" }, series: [{ type: "bar", data: [5, -5, { value: 3, itemStyle: { color: "#123456" } }, null] }] } as O, T, 900) as O;
    const d = v.series[0].data;
    expect(d[0].itemStyle.borderRadius).toEqual([3, 3, 0, 0]);
    expect(d[1].itemStyle.borderRadius).toEqual([0, 0, 3, 3]);
    expect(d[2].itemStyle).toEqual({ color: "#123456", borderRadius: [3, 3, 0, 0] }); // the bar's own colour is kept
    expect(d[3]).toBeNull();
    const h = withChartTheme({ xAxis: { type: "value" }, yAxis: { type: "category" }, series: [{ type: "bar", data: [5, -5] }] } as O, T, 900) as O;
    expect(h.series[0].data[0].itemStyle.borderRadius).toEqual([0, 3, 3, 0]); // sideways: positive rounds on the right
    expect(h.series[0].data[1].itemStyle.borderRadius).toEqual([3, 0, 0, 3]); // negative rounds on the left
    const pairs = withChartTheme({ xAxis: { type: "category" }, yAxis: { type: "value" }, series: [{ type: "bar", data: [["a", -2]] }] } as O, T, 900) as O;
    expect(pairs.series[0].data[0].itemStyle.borderRadius).toEqual([0, 0, 3, 3]);
  });
  it("leaves a stacked series and any radius the chart chose alone, and does not touch other series", () => {
    const out = withChartTheme({ xAxis: { type: "category" }, yAxis: { type: "value" }, series: [
      { type: "bar", stack: "s", data: [1, -1] }, { type: "bar", itemStyle: { borderRadius: 0 }, data: [1, -1] },
      { type: "bar", data: [{ value: -4, itemStyle: { borderRadius: [1, 1, 1, 1] } }] }, { type: "scatter", data: [] }] } as O, T, 900) as O;
    expect(out.series[0].data).toEqual([1, -1]);
    expect(out.series[1].data).toEqual([1, -1]);
    expect(out.series[2].data[0].itemStyle.borderRadius).toEqual([1, 1, 1, 1]);
    expect(out.series[3].itemStyle).toBeUndefined();
  });
  it("handles array axes, array legends and an option without them", () => {
    const out = withChartTheme({ yAxis: [{ type: "value" }, { type: "value", position: "right" }], legend: [{}, {}] } as O, T, 900) as O;
    expect(out.yAxis).toHaveLength(2); expect(out.yAxis[1].splitLine.lineStyle.type).toBe("dashed");
    expect(out.legend).toHaveLength(2); expect(out.legend[0].icon).toBe("roundRect");
    expect(withChartTheme({} as O, T, 900)).toMatchObject({ textStyle: { fontFamily: "IBM Plex Sans" } });
  });
});

describe("recent pages", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the newest first, once each, to the limit, and ignores Home", () => {
    for (const p of ["/a", "/b", "/c", "/a", "/", "/d", "/e", "/f", "/g"]) rememberPage(p);
    const got = loadRecent();
    expect(got[0]).toBe("/g"); expect(got).toHaveLength(RECENT_MAX);
    expect(new Set(got).size).toBe(got.length);
    expect(got).not.toContain("/");
    expect(got).toEqual(["/g", "/f", "/e", "/d", "/a", "/c"]); // "/a" moved up when it was opened again; "/b", the oldest, fell off
  });
  it("survives a broken stored value", () => {
    localStorage.setItem("nse.recent.v1", "{not json");
    expect(loadRecent()).toEqual([]);
    localStorage.setItem("nse.recent.v1", JSON.stringify([1, "/x", null]));
    expect(loadRecent()).toEqual(["/x"]);
  });
});

describe("OfflineStrip", () => {
  const qc = () => new QueryClient();
  const show = () => render(<QueryClientProvider client={qc()}><OfflineStrip /></QueryClientProvider>);
  afterEach(() => vi.restoreAllMocks());
  it("is silent online, says so when the connection drops, and says it is refreshing when it returns", () => {
    show();
    expect(screen.queryByTestId("offline-strip")).toBeNull();
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByTestId("offline-strip")).toHaveTextContent("You are offline");
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(screen.queryByTestId("offline-strip")).toBeNull();
    expect(screen.getByTestId("online-again")).toHaveTextContent("Back online");
  });
});

describe("Home", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  });
  afterEach(() => vi.unstubAllGlobals());
  const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Home /></MemoryRouter></QueryClientProvider>);

  it("offers the pages opened last, the four start cards and a filterable list of every tool", async () => {
    rememberPage("/strategy"); rememberPage("/option-chain");
    mount();
    const recent = within(await screen.findByTestId("home-recent"));
    expect(recent.getAllByRole("link").map((a) => a.textContent)).toEqual(["Option Chain", "Strategy Builder"]); // newest first
    expect(within(screen.getByRole("region", { name: "Start here" })).getAllByRole("link")).toHaveLength(4);
    const group = screen.getByRole("group", { name: "Show" });
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Analyse" }));
    expect(within(group).getByRole("button", { name: "Analyse" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "FNO Tools", level: 3 })).toBeNull(); // only the chosen menu is listed
  });

  it("searches by name and '/' puts the cursor in the search box", async () => {
    mount();
    const box = screen.getByRole("searchbox", { name: "Search tools" });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(box).toHaveFocus();
    await userEvent.type(box, "zzzzzz-no-such-tool");
    expect(screen.getByText(/No tool matches/)).toBeInTheDocument();
  });

  it("shows no recent section on a first visit, and still says when the market summary is unavailable", async () => {
    mount();
    expect(screen.queryByTestId("home-recent")).toBeNull();
    expect(await screen.findByTestId("home-no-intel")).toHaveTextContent("The tools below still work");
  });
});
