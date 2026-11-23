// The closing auction (23 Nov 2026: the index feed printed 24,853 for minutes while the traded level was 25,366 and the broker kept showing it).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotBadge } from "../components/SpotBadge";
import { INDEX_KEY, liveStore } from "../lib/liveStore";
import { inIndicativeWindow, resetLastTraded } from "../lib/useLive";
import { liveTick, status, streamStatus, summary } from "./fixtures";

const latest = summary({ underlying_ltp: 25398.27, underlying_prev_close: 25796.0, retrieved_at: "2026-11-23T09:49:05Z" });
const at = (hm: string) => `2026-11-23T${hm}:00Z`; // UTC: 09:40Z is 15:10 IST

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status()), { status: 200 })));
  return render(<QueryClientProvider client={qc}><div className="xl:flex"><SpotBadge latest={latest} /></div></QueryClientProvider>);
}
function feed(ltp: number, received_at: string, seq: number) {
  act(() => {
    liveStore.setConn("open");
    liveStore.apply({ type: "hello", status: streamStatus({ state: "streaming", effective_state: "streaming" }), ticks: [liveTick({ key: INDEX_KEY, kind: "index", ltp, prev_close: 25796.0, received_at, seq })] });
  });
}
beforeEach(() => { liveStore.reset(); resetLastTraded(); });
afterEach(() => vi.unstubAllGlobals());

describe("the indicative window", () => {
  it("is 15:20 to 15:30 IST until 4 Dec 2026 and 15:31 to 15:40 from 7 Dec, weekdays only", () => {
    expect(inIndicativeWindow(Date.parse(at("09:49")))).toBe(false); // 15:19
    expect(inIndicativeWindow(Date.parse(at("09:50")))).toBe(true); // 15:20
    expect(inIndicativeWindow(Date.parse(at("09:59")))).toBe(true); // 15:29
    expect(inIndicativeWindow(Date.parse(at("10:00")))).toBe(false); // 15:30
    expect(inIndicativeWindow(Date.parse("2026-12-08T10:00:00Z"))).toBe(false); // 15:30 on 8 Dec is the reference price, not yet indicative
    expect(inIndicativeWindow(Date.parse("2026-12-08T10:01:00Z"))).toBe(true); // 15:31
    expect(inIndicativeWindow(Date.parse("2026-11-22T09:55:00Z"))).toBe(false); // a Sunday
  });
});

describe("spot badge in the closing auction", () => {
  it("keeps the last traded level and shows the auction estimate beside it, labelled", () => {
    show();
    feed(25366.4, at("09:44"), 1); // continuous trading
    expect(screen.getByText("25,366.40")).toBeInTheDocument();
    feed(24855.85, at("09:51"), 2); // the indicative value 15:21 IST
    expect(screen.getByText("25,366.40")).toBeInTheDocument(); // the level did not move
    expect(screen.queryByText("24,855.85", { selector: ".text-paper" })).toBeNull();
    expect(screen.getByTestId("spot-indicative")).toHaveTextContent("indicative 24,855.85");
    expect(screen.getByTestId("spot-indicative")).toHaveTextContent("Closing auction");
  });
  it("opened inside the auction with no traded level seen, it shows the stored snapshot (not the auction estimate) and still labels the estimate", () => {
    show();
    feed(24855.85, at("09:51"), 1);
    expect(screen.getByText("25,398.27")).toBeInTheDocument();
    expect(screen.getByTestId("spot-indicative")).toHaveTextContent("24,855.85");
  });
  it("after the window the index is a normal live price again and the label is gone", () => {
    show();
    feed(25349.65, at("10:01"), 3); // 15:31 IST, the auction is over
    expect(screen.getByText("25,349.65")).toBeInTheDocument();
    expect(screen.queryByTestId("spot-indicative")).toBeNull();
  });
});
