import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StraddleRestrikeLog } from "../components/intelligence/StraddleRestrikeLog";
import type { ManagedBook, ManagedHistory, StraddleDecay } from "../lib/straddleDecay";

// 27 Nov 2026 (IST), one lot of 65. Hand calculation of the book below:
//   pair 1: 25900 sold at 285.00, bought back at 330.00 -> 285 - 330 = -45.00 points = -₹2,925
//   pair 2: 25800 sold at 300.00, bought back at 260.00 ->  300 - 260 = +40.00 points = +₹2,600
//   held:   25700 sold at 280.00, now 250.00            ->  280 - 250 = +30.00 points = +₹1,950
//   booked -45 + 40 = -5.00, open +30.00, total +25.00 points = +₹1,625
const book: ManagedBook = {
  threshold: 100, restrikes: 2, lot_size: 65, strike_now: 25700, realised: -5, open_pnl: 30, total: 25, total_rupees: 1625,
  segments: [
    { strike: 25900, from: "2026-11-27T03:45:00+00:00", to: "2026-11-27T05:12:00+00:00", entry: 285, exit: 330, pnl: -45, exit_carried: false },
    { strike: 25800, from: "2026-11-27T05:12:00+00:00", to: "2026-11-27T07:03:00+00:00", entry: 300, exit: 260, pnl: 40, exit_carried: true },
  ],
  open: { strike: 25700, from: "2026-11-27T07:03:00+00:00", entry: 280, last: 250, pnl: 30 },
};
// 26 Nov: no re-strike, one pair sold at 301.50 and now 314.00 -> 301.5 - 314 = -12.50 points = -₹812.50
const older: ManagedBook = { threshold: 100, restrikes: 0, lot_size: 65, strike_now: 25850, realised: 0, open_pnl: -12.5, total: -12.5, total_rupees: -812.5, segments: [], open: { strike: 25850, from: "2026-11-26T03:45:00+00:00", entry: 301.5, last: 314, pnl: -12.5 } };
const history: ManagedHistory = {
  generated_at: "2026-11-27T10:10:00+00:00", threshold: 100,
  days: [
    { session: "2026-11-27", expiry: "2026-12-01", live: false, opening_at: "2026-11-27T03:45:00+00:00", book, message: null },
    { session: "2026-11-26", expiry: "2026-11-26", live: false, opening_at: "2026-11-26T03:45:00+00:00", book: older, message: null },
    { session: "2026-11-25", expiry: "2026-11-25", live: false, opening_at: null, book: null, message: "No managed-straddle book for this session." },
  ],
  totals: { sessions: 2, restrikes: 2, total: 12.5, total_rupees: 812.5, winning_sessions: 1 },
};
const d = { status: "ok", session: "2026-11-27", expiry: "2026-12-01", tracker: { managed: { ...book, note: "" } } } as unknown as StraddleDecay;
let calls: string[];
let answer: () => Response;

beforeEach(() => {
  calls = [];
  answer = () => new Response(JSON.stringify(history), { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return answer(); }));
});
afterEach(() => vi.unstubAllGlobals());
const mount = (data: StraddleDecay = d) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StraddleRestrikeLog d={data} /></QueryClientProvider>);

describe("Re-strike log", () => {
  it("lists each pair of the session with times, prices and profit in points and rupees, then the pair still held and the total", () => {
    mount();
    const session = screen.getByTestId("restrike-session");
    const rows = within(session).getAllByTestId("restrike-trade");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("25900"); expect(rows[0]).toHaveTextContent("09:15"); expect(rows[0]).toHaveTextContent("10:42");
    expect(rows[0]).toHaveTextContent("285.00"); expect(rows[0]).toHaveTextContent("330.00"); expect(rows[0]).toHaveTextContent("−45.00"); expect(rows[0]).toHaveTextContent("−₹2,925");
    expect(rows[1]).toHaveTextContent("+40.00"); expect(rows[1]).toHaveTextContent("+₹2,600");
    expect(rows[1]!.querySelector("[title*='no price']")).not.toBeNull(); // the exit that used the last earlier price is marked
    expect(rows[0]!.querySelector("[title*='no price']")).toBeNull();
    const held = within(session).getByTestId("restrike-open");
    expect(held).toHaveTextContent("25700"); expect(held).toHaveTextContent("held"); expect(held).toHaveTextContent("280.00"); expect(held).toHaveTextContent("+30.00"); expect(held).toHaveTextContent("+₹1,950");
    const total = within(session).getByTestId("restrike-total");
    expect(total).toHaveTextContent("2 re-strikes"); expect(total).toHaveTextContent("booked −5.00"); expect(total).toHaveTextContent("open +30.00"); expect(total).toHaveTextContent("+25.00"); expect(total).toHaveTextContent("+₹1,625");
  });

  it("says so when the session has no book, and does not invent a trade", () => {
    mount({ status: "ok", session: "2026-11-27", expiry: "2026-12-01", tracker: {} } as unknown as StraddleDecay);
    expect(screen.getByTestId("restrike-nobook")).toBeInTheDocument();
    expect(screen.queryByTestId("restrike-trade")).toBeNull();
  });

  it("shows the stored sessions with their totals and opens a day's trades on click", async () => {
    mount();
    const hist = await screen.findByTestId("restrike-history");
    const days = await within(hist).findAllByTestId("restrike-day");
    expect(days).toHaveLength(3);
    expect(days[0]).toHaveTextContent("27/11/2026"); expect(days[0]).toHaveTextContent("+25.00"); expect(days[0]).toHaveTextContent("+₹1,625");
    expect(days[1]).toHaveTextContent("−12.50"); expect(days[1]).toHaveTextContent("−₹813");
    const total = within(hist).getByTestId("restrike-history-total");
    expect(total).toHaveTextContent("2 sessions · 1 in profit"); expect(total).toHaveTextContent("+12.50"); expect(total).toHaveTextContent("+₹813"); // 25.00 - 12.50 points; 1,625 - 812.5 rupees
    expect(calls[0]).toContain("/api/intelligence/straddle/managed-history");
    expect(within(hist).queryByTestId("restrike-trades-2026-11-26")).toBeNull();
    fireEvent.click(within(days[1]!).getByRole("button", { name: "Trades of 26/11/2026" }));
    const opened = await within(hist).findByTestId("restrike-trades-2026-11-26");
    expect(within(opened).getByTestId("restrike-open")).toHaveTextContent("301.50"); // a day with no re-strike: one pair held from the open
    expect(within(opened).queryAllByTestId("restrike-trade")).toHaveLength(0);
  });

  it("a session without a book cannot be opened", async () => {
    mount();
    const days = await screen.findAllByTestId("restrike-day");
    expect(within(days[2]!).getByRole("button", { name: "Trades of 25/11/2026" })).toBeDisabled();
  });

  it("names a failed history request instead of showing an empty table", async () => {
    answer = () => new Response(JSON.stringify({ detail: { code: "disabled", message: "straddle decay is turned off" } }), { status: 404 });
    mount();
    expect(await screen.findByTestId("restrike-history-error")).toHaveTextContent("could not be loaded");
    await waitFor(() => expect(screen.queryByTestId("restrike-day")).toBeNull());
  });
});
