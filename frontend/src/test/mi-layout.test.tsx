// Market Intelligence layout pieces: scrollable alerts with a severity filter, the section navigator, and the data-quality table with its "why" labels.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Capabilities, asOf } from "../components/intelligence/Capabilities";
import { AlertsPanel } from "../components/intelligence/Insight";
import type { AlertRow, Capability } from "../lib/intelligence";

const alert = (id: number, severity: string): AlertRow => ({ id, at: "2026-11-11T05:00:00Z", kind: `Kind ${id}`, severity, direction: "neutral", text: `text ${id}`, evidence: [], confirmation: "holds", invalidation: "reverses" } as unknown as AlertRow);
const cap = (id: string, status: Capability["status"], o: Partial<Capability> = {}): Capability => ({ id, name: `Name ${id}`, status, reason: `reason ${id}`, source: "market", as_of: null, link: null, ...o });

describe("alert centre", () => {
  const alerts = [alert(1, "high"), alert(2, "medium"), alert(3, "high"), alert(4, "low")];
  it("is a scrollable list with the count and a severity filter", () => {
    render(<AlertsPanel alerts={alerts} />);
    const list = screen.getByTestId("mi-alerts-list");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("max-h-");
    expect(list.getAttribute("tabindex")).toBe("0"); // reachable and scrollable with the keyboard
    expect(screen.getByTestId("mi-alert-count").textContent).toContain("4 today");
    expect(screen.getAllByTestId("mi-alert")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "High 2" }));
    expect(screen.getAllByTestId("mi-alert")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Medium 1" }));
    expect(screen.getAllByTestId("mi-alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    expect(screen.getAllByTestId("mi-alert")).toHaveLength(4);
  });
  it("says so when there are no alerts, and when a filter matches none", () => {
    const { unmount } = render(<AlertsPanel alerts={[]} />);
    expect(screen.getByTestId("mi-no-alerts")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Filter alerts/ })).toBeNull();
    unmount();
    render(<AlertsPanel alerts={[alert(1, "high")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Medium 0" }));
    expect(screen.getByTestId("mi-no-alerts-filtered").textContent).toContain("No medium alert");
  });
});

describe("data quality table", () => {
  const items = [
    cap("a", "AVAILABLE", { as_of: "2026-11-11T04:29:58+00:00" }),
    cap("b", "PARTIAL", { as_of: "2026-11-11T09:45:00+00:00", reason: "from the last stored minute (15:15 IST)" }),
    cap("c", "UNAVAILABLE", { why: "feed", reason: "the feed carries no aggressor side" }),
    cap("d", "UNAVAILABLE", { why: "not_subscribed" }),
    cap("e", "UNAVAILABLE", { why: "no_data_yet" }),
  ];
  const mount = () => render(<MemoryRouter><Capabilities items={items} /></MemoryRouter>);
  it("counts each state and splits the unavailable ones by why", () => {
    mount();
    const t = screen.getByTestId("mi-cap-summary").textContent!;
    expect(t).toContain("1 available");
    expect(t).toContain("1 partial");
    expect(t).toContain("3 unavailable");
    expect(t).toContain("1 the broker feed does not carry");
    expect(t).toContain("1 not subscribed yet");
  });
  it("labels why a capability does not exist, but not for an available one", () => {
    mount();
    expect(within(screen.getByTestId("mi-cap-c")).getByText("Not in the broker feed")).toBeTruthy();
    expect(within(screen.getByTestId("mi-cap-d")).getByText("Not subscribed yet")).toBeTruthy();
    expect(within(screen.getByTestId("mi-cap-e")).getByText("No data stored yet")).toBeTruthy();
    expect(within(screen.getByTestId("mi-cap-a")).queryByText(/Not in the broker feed/)).toBeNull();
    expect(screen.getByTestId("mi-cap-b").textContent).toContain("last stored minute");
  });
  it("shows a source time in IST, a daily date as a date, and a dash for none", () => {
    expect(asOf("2026-11-11T04:29:58+00:00")).toContain("09:59:58 IST");
    expect(asOf("2026-11-11")).toBe("2026-11-11 (daily)");
    expect(asOf(null)).toBe("—");
  });
  it("can show only what is not fully available", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByTestId("mi-cap-a")).toBeNull();
    expect(screen.getByTestId("mi-cap-b")).toBeTruthy();
    expect(screen.getByTestId("mi-cap-e")).toBeTruthy();
  });
});
