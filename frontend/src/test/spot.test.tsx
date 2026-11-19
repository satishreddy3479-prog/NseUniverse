import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotBadge } from "../components/SpotBadge";
import { INDEX_KEY, liveStore } from "../lib/liveStore";
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

  it("does not hold a price older than the stored snapshot: the snapshot is the newer value", () => {
    showWith(summary({ underlying_ltp: 25500.0, underlying_prev_close: 25227.95, retrieved_at: "2026-11-19T04:00:00Z" })); // 09:30 IST
    feedTick("stale", preOpenTick("2026-11-19T03:38:00Z"));
    expect(screen.getByText("25,500.00")).toBeInTheDocument();
    expect(screen.queryByTestId("spot-held")).toBeNull();
  });
});
