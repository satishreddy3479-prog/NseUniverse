import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotBadge } from "../components/SpotBadge";
import { INDEX_KEY, liveStore } from "../lib/liveStore";
import { resetSessionClock, setSessionClock } from "../lib/session";
import { isLiveTickTime } from "../lib/useLive";
import { liveTick, status, streamStatus, summary } from "./fixtures";

const latest = summary({ underlying_ltp: 22698.85, underlying_prev_close: 22749.75 });

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status()), { status: 200 })));
  return render(
    <QueryClientProvider client={qc}>
      <div className="xl:flex"><SpotBadge latest={latest} /></div>
    </QueryClientProvider>,
  );
}

function feed(effective: string, ltp: number) {
  act(() => {
    liveStore.setConn("open");
    liveStore.apply({
      type: "hello",
      status: streamStatus({ state: "streaming", effective_state: effective }),
      ticks: [liveTick({ key: INDEX_KEY, kind: "index", ltp, prev_close: 22749.75, seq: 1 })],
    });
  });
}

beforeEach(() => liveStore.reset());
afterEach(() => vi.unstubAllGlobals());

describe("spot badge: live only when the stream is genuinely fresh", () => {
  it("shows the streamed value, labelled Live, while fresh", () => {
    show();
    feed("streaming", 22800.5);
    expect(screen.getByText("22,800.50")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it.each(["stale", "market_closed", "waiting_for_data"])(
    "falls back to the labelled snapshot when the stream is %s",
    (effective) => {
      show();
      feed(effective, 22800.5);
      expect(screen.queryByText("22,800.50")).toBeNull();
      expect(screen.getByText("22,698.85")).toBeInTheDocument();
      expect(screen.queryByText("Live")).toBeNull();
    },
  );
});

describe("spot badge: the pre-open price is held until the market opens", () => {
  // 19 Nov style morning: yesterday's last stored snapshot is the previous close; the pre-open session prints a level until 09:08 IST, then the index is quiet until 09:15.
  const yesterdayClose = summary({ underlying_ltp: 25227.95, underlying_prev_close: 25100.0, retrieved_at: "2026-11-18T10:09:00Z" });
  const preOpenTick = (received_at: string) => liveTick({ key: INDEX_KEY, kind: "index", ltp: 25396.5, prev_close: 25227.95, received_at, seq: 5 });

  function showWith(latestSnap: ReturnType<typeof summary>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status()), { status: 200 })));
    return render(<QueryClientProvider client={qc}><SpotBadge latest={latestSnap} /></QueryClientProvider>);
  }
  function feedTick(effective: string, tick: ReturnType<typeof liveTick>) {
    act(() => {
      liveStore.setConn("open");
      liveStore.apply({ type: "hello", status: streamStatus({ state: "streaming", effective_state: effective }), ticks: [tick] });
    });
  }

  it("keeps the last live price, labelled Held, when the stream goes quiet after pre-open (09:08-09:15)", () => {
    showWith(yesterdayClose);
    feedTick("stale", preOpenTick("2026-11-19T03:38:00Z")); // 09:08 IST
    expect(screen.getByText("25,396.50")).toBeInTheDocument();
    expect(screen.queryByText("25,227.95")).toBeNull(); // yesterday's close is not shown as the price
    expect(screen.getByTestId("spot-held")).toHaveTextContent(/Held 09:08/);
    expect(screen.getByRole("button", { name: "Help: how to read this" })).toBeInTheDocument(); // the Held label explains itself
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.getByText("+169 (+0.67%)")).toBeInTheDocument(); // the change is still against the previous close: 25,396.50 - 25,227.95 = 168.55, shown rounded
  });

  it("is live again as soon as the market opens, and the held label goes", () => {
    showWith(yesterdayClose);
    feedTick("stale", preOpenTick("2026-11-19T03:38:00Z"));
    feedTick("streaming", preOpenTick("2026-11-19T03:45:02Z")); // 09:15:02 IST
    expect(screen.queryByTestId("spot-held")).toBeNull();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("a quote the broker sends again after a restart at night is not 'Held 23:15': the stored snapshot is shown with its own date and time", () => {
    // Sunday 22 Nov 2026, 23:15:21 IST: the backend restarted and replayed Friday's close; the stored snapshot is Friday 20 Nov 15:39 IST
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-22T17:46:00Z"));
    try {
      showWith(summary({ underlying_ltp: 25800.6, underlying_prev_close: 25514.6, retrieved_at: "2026-11-20T10:09:04Z" }));
      feedTick("market_closed", preOpenTick("2026-11-22T17:45:21Z")); // 23:15:21 IST
      expect(screen.queryByTestId("spot-held")).toBeNull();
      expect(screen.getByText("25,800.60")).toBeInTheDocument();
      expect(screen.getByText(/15:39:04 IST · 20 Nov/)).toBeInTheDocument(); // the real time of the price, with its date
      expect(document.body.textContent).not.toContain("23:15");
    } finally { vi.useRealTimers(); }
  });

  it("a snapshot fetched again on a holiday morning keeps showing the last session close, not the time of the restart", () => {
    // Tuesday 24 Nov 2026 was an exchange holiday; each restart stored a new snapshot (10:32:38 IST) holding Monday's closing prices
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-24T08:00:00Z"));
    setSessionClock({ open: "09:15", close: "15:40", label: "09:15–15:40", source: "test", holidays: ["2026-11-24"] });
    try {
      const { unmount } = showWith(summary({ underlying_ltp: 25349.65, underlying_prev_close: 25800.6, retrieved_at: "2026-11-24T05:02:38Z" }));
      expect(screen.getByText(/15:40:00 IST · 23 Nov/)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("10:32");
      unmount();
      // a later restart the same day: the same close, the badge does not change
      showWith(summary({ underlying_ltp: 25349.65, underlying_prev_close: 25800.6, retrieved_at: "2026-11-24T07:41:09Z" }));
      expect(screen.getByText(/15:40:00 IST · 23 Nov/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); resetSessionClock(); }
  });

  it("a snapshot fetched during the session shows its own time; one fetched after the close shows the close", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-23T11:30:00Z")); // Monday 23 Nov, 17:00 IST
    try {
      const { unmount } = showWith(summary({ underlying_ltp: 25349.65, underlying_prev_close: 25800.6, retrieved_at: "2026-11-23T08:14:10Z" })); // 13:44:10 IST
      expect(screen.getByText(/^13:44:10 IST · 23 Nov/)).toBeInTheDocument();
      unmount();
      showWith(summary({ underlying_ltp: 25349.65, underlying_prev_close: 25800.6, retrieved_at: "2026-11-23T11:20:00Z" })); // 16:50 IST, after the close
      expect(screen.getByText(/^15:40:00 IST · 23 Nov/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("a tick received during the session on a day the exchange reports closed (a holiday) is not held either", () => {
    showWith(summary({ underlying_ltp: 25500.0, underlying_prev_close: 25227.95, retrieved_at: "2026-11-19T04:00:00Z" }));
    feedTick("market_closed", preOpenTick("2026-11-19T05:30:00Z")); // 11:00 IST, newer than the snapshot
    expect(screen.queryByTestId("spot-held")).toBeNull();
  });

  it("does not hold a price older than the stored snapshot: the snapshot is the newer value", () => {
    showWith(summary({ underlying_ltp: 25500.0, underlying_prev_close: 25227.95, retrieved_at: "2026-11-19T04:00:00Z" })); // 09:30 IST
    feedTick("stale", preOpenTick("2026-11-19T03:38:00Z"));
    expect(screen.getByText("25,500.00")).toBeInTheDocument();
    expect(screen.queryByTestId("spot-held")).toBeNull();
  });
});

describe("isLiveTickTime", () => {
  it("is a weekday between 09:00 and 15:45 IST and nothing else", () => {
    const at = (iso: string) => isLiveTickTime(Date.parse(iso));
    expect(at("2026-11-20T03:30:00Z")).toBe(true); // Fri 09:00 IST
    expect(at("2026-11-20T10:15:00Z")).toBe(true); // Fri 15:45 IST
    expect(at("2026-11-20T03:29:00Z")).toBe(false); // 08:59
    expect(at("2026-11-20T10:16:00Z")).toBe(false); // 15:46
    expect(at("2026-11-22T17:45:21Z")).toBe(false); // Sunday 23:15
    expect(at("2026-11-21T05:00:00Z")).toBe(false); // Saturday 10:30
    expect(at("2026-11-20T19:00:00Z")).toBe(false); // Friday 00:30 Saturday IST
  });
});
