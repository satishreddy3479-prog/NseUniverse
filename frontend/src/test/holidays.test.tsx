import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HolidaysPanel } from "../components/HolidaysPanel";
import type { HolidaysView } from "../lib/api";
import { daysUntil, mergeRows, parseHolidayText } from "../lib/holidays";

describe("reading the circular", () => {
  it("understands the layouts people paste, skipping the serial number and the weekday word", () => {
    const p = parseHolidayText([
      "26-Jan-2027 Tuesday Republic Day",
      "3 26-Mar-2027 Friday Good Friday",
      "2027-10-20 Dussehra",
      "14/04/2027 - Dr. Baba Saheb Ambedkar Jayanti",
      "14 April 2027 Wednesday Ambedkar Jayanti again",
    ].join("\n"));
    expect(p.map((x) => [x.date, x.name, x.error, x.weekend])).toEqual([
      ["2027-01-26", "Republic Day", undefined, undefined],
      ["2027-03-26", "Good Friday", undefined, undefined],
      ["2027-10-20", "Dussehra", undefined, undefined],
      ["2027-04-14", "Dr. Baba Saheb Ambedkar Jayanti", undefined, undefined],
      ["2027-04-14", "Ambedkar Jayanti again", undefined, undefined],
    ]);
  });

  it("flags weekends and every line it cannot read instead of dropping it", () => {
    const p = parseHolidayText("30-Jan-2027 Saturday Something\nRepublic Day\n31-Feb-2027 Nonsense\n26-Jan-2027\n\n   ");
    expect(p).toHaveLength(4); // blank lines are ignored, nothing else
    expect(p[0]).toMatchObject({ date: "2027-01-30", weekend: true });
    expect(p[1]!.error).toMatch(/No date/);
    expect(p[2]!.error).toMatch(/real calendar date/);
    expect(p[3]!.error).toMatch(/No holiday name/);
  });

  it("merges by date, the later text winning, in date order, and counts days", () => {
    expect(mergeRows([{ date: "2027-03-26", name: "old" }, { date: "2027-01-26", name: "Republic Day" }], [{ date: "2027-03-26", name: "Good Friday" }])).toEqual([
      { date: "2027-01-26", name: "Republic Day" }, { date: "2027-03-26", name: "Good Friday" },
    ]);
    expect(daysUntil("2026-12-31", new Date("2026-11-13T05:00:00Z"))).toBe(48);
  });
});

const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

function view(over: Partial<HolidaysView> = {}): HolidaysView {
  return {
    reference: { coverage: ["2026-01-01", ymd(30)], holidays: [{ date: "2026-01-26", name: "Republic Day" }], special_sessions: [] },
    user: { coverage_to: null, source: null, updated_at: null, holidays: [], special_sessions: [] },
    effective_coverage: ["2026-01-01", ymd(30)],
    ...over,
  };
}

function setup(initial: HolidaysView) {
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/market/holidays") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { coverage_to: string; source: string; holidays: { date: string; name: string }[]; special_sessions: { date: string; name: string }[] };
      puts.push(body);
      return new Response(JSON.stringify({ ...initial, user: { coverage_to: body.coverage_to, source: body.source, updated_at: "now", holidays: body.holidays, special_sessions: body.special_sessions }, effective_coverage: [initial.effective_coverage[0], body.coverage_to] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/market/holidays")) return new Response(JSON.stringify(initial), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><HolidaysPanel /></QueryClientProvider>);
  return puts;
}
afterEach(() => vi.unstubAllGlobals());

describe("Settings: exchange holidays", () => {
  it("warns when the list is about to end and explains what happens after", async () => {
    setup(view());
    expect(await screen.findByTestId("holiday-warning")).toHaveTextContent("The list ends on");
    expect(screen.getByTestId("holiday-summary")).toHaveTextContent("treats every weekday as a session");
  });

  it("pastes the circular, adds the lines, asks for the confirmation and saves exactly what was entered", async () => {
    const puts = setup(view());
    await screen.findByTestId("holiday-summary");
    await userEvent.type(screen.getByLabelText(/Paste the holidays/), "26-Jan-2027 Tuesday Republic Day{enter}30-Jan-2027 Saturday Weekend one{enter}14-Apr-2027 Wednesday Ambedkar Jayanti{enter}garbage line");
    await userEvent.click(screen.getByRole("button", { name: "Add these lines" }));
    const note = screen.getByTestId("holiday-note");
    expect(note).toHaveTextContent("2 holidays added");
    expect(note).toHaveTextContent("1 on a weekend skipped");
    expect(note).toHaveTextContent("not understood");
    const rows = within(screen.getByTestId("holiday-rows")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect((screen.getByLabelText("Date of entry 1") as HTMLInputElement).value).toBe("2027-01-26");
    expect((screen.getByLabelText("Name of entry 2") as HTMLInputElement).value).toBe("Ambedkar Jayanti");
    expect((screen.getByLabelText("Covered up to") as HTMLInputElement).value).toBe("2027-12-31"); // follows the newest date
    const save = screen.getByRole("button", { name: "Save holidays" });
    await userEvent.type(screen.getByLabelText(/Source/), "NSE circular NSE/CMTR/1 dated 12 Dec 2026");
    expect(screen.getByRole("checkbox")).not.toBeChecked(); // extending the period needs the explicit tick
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(save);
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      coverage_to: "2027-12-31", source: "NSE circular NSE/CMTR/1 dated 12 Dec 2026", confirm_complete: true,
      holidays: [{ date: "2027-01-26", name: "Republic Day" }, { date: "2027-04-14", name: "Ambedkar Jayanti" }], special_sessions: [],
    });
    expect(await screen.findByText(/Saved\. The app now treats/)).toBeInTheDocument();
  });

  it("shows the server's reason when a save is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ detail: { code: "invalid_holidays", message: "Holiday 2027-01-26 is already in the NSE circular list (Republic Day)." } }), { status: 422, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(view({ user: { coverage_to: ymd(400), source: "NSE circular x", updated_at: "t", holidays: [{ date: "2027-01-26", name: "Republic Day" }], special_sessions: [] } })), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><HolidaysPanel /></QueryClientProvider>);
    await screen.findByTestId("holiday-rows");
    await userEvent.clear(screen.getByLabelText("Name of entry 1"));
    await userEvent.type(screen.getByLabelText("Name of entry 1"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save holidays" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already in the NSE circular list");
  });
});
