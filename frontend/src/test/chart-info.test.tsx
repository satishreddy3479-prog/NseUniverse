import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { getHideInfo, setHideInfo, subscribeHideInfo, withInfoHidden } from "../lib/chartInfo";

beforeEach(() => { setHideInfo(false); localStorage.clear(); });

describe("hide info on charts", () => {
  const option = { tooltip: { trigger: "axis", axisPointer: { type: "cross" } }, series: [{ name: "a", type: "line" }, { name: "b", type: "bar", tooltip: { trigger: "item" } }], xAxis: {} };

  it("sets the card on explicitly while the info is shown, so a card that was hidden comes back (ECharts keeps a key that is merely absent)", () => {
    const o = withInfoHidden(option, false) as typeof option & { tooltip: { showContent?: boolean } };
    expect(o.tooltip.showContent).toBe(true);
    expect((o.series[1] as { tooltip: { showContent?: boolean } }).tooltip.showContent).toBe(true);
    expect((option.tooltip as { showContent?: boolean }).showContent).toBeUndefined(); // the original is not changed
  });
  it("turns the card off but keeps the tooltip's other settings, so the crosshair stays", () => {
    const o = withInfoHidden(option, true) as typeof option & { tooltip: { showContent?: boolean; trigger: string; axisPointer: unknown } };
    expect(o.tooltip.showContent).toBe(false);
    expect(o.tooltip.trigger).toBe("axis");
    expect(o.tooltip.axisPointer).toEqual({ type: "cross" });
    expect((o.series[1] as { tooltip: { showContent?: boolean } }).tooltip.showContent).toBe(false); // a series with a tooltip of its own too
    expect((o.series[0] as { tooltip?: unknown }).tooltip).toBeUndefined(); // one without stays without
    expect((option.tooltip as { showContent?: boolean }).showContent).toBeUndefined(); // the original is not changed
  });
  it("handles several tooltips and a chart with none", () => {
    const two = withInfoHidden({ tooltip: [{ trigger: "axis" }, { trigger: "item" }] }, true) as unknown as { tooltip: { showContent: boolean }[] };
    expect(two.tooltip.map((t) => t.showContent)).toEqual([false, false]);
    expect(withInfoHidden({ series: [] }, true)).toEqual({ series: [] });
  });
  it("one choice for every chart: changing it tells every subscriber and is remembered in this browser", () => {
    const seen = vi.fn();
    const off = subscribeHideInfo(seen);
    setHideInfo(true);
    expect(getHideInfo()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nse.charts.hideInfo")).toBe("1");
    off();
    setHideInfo(false);
    expect(seen).toHaveBeenCalledTimes(1); // an unsubscribed chart is not told
    expect(localStorage.getItem("nse.charts.hideInfo")).toBe("0");
  });
});

describe("the Hide chart info button", () => {
  it("is one switch for all charts: it says what it will do, and pressing it flips the shared choice and its own label", () => {
    render(<><ChartInfoToggle /><ChartInfoToggle /></>); // two sections of a page, each with the button
    const [a, b] = screen.getAllByTestId("chart-info-toggle");
    expect(a).toHaveTextContent("Hide chart info");
    expect(a).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(a!);
    expect(getHideInfo()).toBe(true);
    expect(a).toHaveTextContent("Show chart info");
    expect(b).toHaveTextContent("Show chart info"); // the other button follows: it is the same choice
    expect(b).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(b!);
    expect(getHideInfo()).toBe(false);
    expect(a).toHaveTextContent("Hide chart info");
  });
});
