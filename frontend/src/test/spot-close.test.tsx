import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotBadge } from "../components/SpotBadge";
import { liveStore } from "../lib/liveStore";
import { status, summary } from "./fixtures";

// 26 Nov 2026: the header showed 25,884.50 while the page was open, then 25,889.20 after a reload (the stored chain's index level, frozen since 15:15, with the time of the latest snapshot).
const snap = summary({ underlying_ltp: 25889.2, underlying_prev_close: 25819.25, retrieved_at: "2026-11-26T10:09:05Z" });

function show(close: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("index-close") ? close : status()), { status: 200 })));
  return render(<QueryClientProvider client={qc}><SpotBadge latest={snap} /></QueryClientProvider>);
}

beforeEach(() => liveStore.reset());
afterEach(() => vi.unstubAllGlobals());

describe("spot badge after the close, with no live tick in the browser", () => {
  it("shows the server's closing-auction value, labelled Close, not the frozen snapshot level", async () => {
    show({ day: "2026-11-26", ltp: 25884.5, prev_close: 25819.25, received_at: "2026-11-26T10:00:00+05:30" });
    await waitFor(() => expect(screen.getByText("25,884.50")).toBeInTheDocument());
    expect(screen.queryByText("25,889.20")).toBeNull();
    expect(screen.getByTestId("spot-close")).toHaveTextContent("Close");
    expect(screen.getByText(/\+65 \(\+0\.25%\)/)).toBeInTheDocument(); // 25,884.50 - 25,819.25
  });

  it("ignores a close from an earlier day: the newer snapshot is shown", async () => {
    show({ day: "2026-11-25", ltp: 25800, prev_close: 25700, received_at: "2026-11-25T15:30:00+05:30" });
    await waitFor(() => expect(screen.getByText("25,889.20")).toBeInTheDocument());
    expect(screen.queryByTestId("spot-close")).toBeNull();
  });

  it("shows the snapshot when the server has no close", async () => {
    show({ day: null });
    await waitFor(() => expect(screen.getByText("25,889.20")).toBeInTheDocument());
    expect(screen.queryByTestId("spot-close")).toBeNull();
  });
});
