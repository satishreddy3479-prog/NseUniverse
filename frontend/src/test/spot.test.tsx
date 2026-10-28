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
