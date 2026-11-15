// Replay on the Straddle Intelligence page: off until pressed; then the analysis is asked for as it stood at the replay time.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StraddleIntelligence } from "../pages/StraddleIntelligence";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

const N = 30;
const T0 = Date.parse("2026-11-11T03:46:00Z"); // 09:16 IST
const obs = (i: number) => ({
  snapshot_id: `s${i}`, retrieved_at: new Date(T0 + i * 60_000).toISOString(), session_id: "x", underlying_ltp: 24000, underlying_prev_close: 23950, atm_strike: 24000,
  atm_call_ltp: 100, atm_put_ltp: 100, straddle: 200, total_ce_premium: 700, total_pe_premium: 700, total_ce_oi: 7000, total_pe_oi: 7000, total_ce_volume: 70, total_pe_volume: 70,
  strikes_in_universe: 7, missing_ltp: 0, same_as_previous: false,
});
const asked: string[] = [];
let delayMs = 0; // how long the server "takes" for one analysis
function mount() {
  asked.length = 0;
  delayMs = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(decodeURIComponent(url));
    const asOf = new URL(url, "http://x").searchParams.get("as_of");
    if (asOf && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const body = url.startsWith("/api/history/observations")
      ? { underlying: "NIFTY", expiry: "2026-11-12", strikes_each_side: 10, observations: Array.from({ length: N }, (_, i) => obs(i)), distinct_observations: N, definitions: {}, note: "" }
      : { status: "unavailable", message: "Fewer than two usable stored samples.", session: "2026-11-11", expiry: "2026-11-12", interpretation: [], ...(asOf ? { as_of: asOf } : {}) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><StraddleIntelligence /></QueryClientProvider></MemoryRouter>);
}
const straddleCalls = () => asked.filter((u) => u.startsWith("/api/intelligence/straddle") && !u.includes("/validation") && !u.includes("/alerts"));

describe("Straddle Intelligence replay", () => {
  it("is off until Replay is pressed, and a plain page asks for the latest session without an as_of", async () => {
    mount();
    await screen.findByRole("button", { name: /Replay/ });
    expect(screen.queryByRole("slider", { name: "Replay time" })).toBeNull();
    expect(straddleCalls().every((u) => !u.includes("as_of"))).toBe(true);
  });

  it("asks for the analysis as of the replay time of the replayed day, and Exit returns to the plain request", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Replay/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    const slider = (await screen.findByRole("slider", { name: "Replay time" })) as HTMLInputElement;
    expect(Number(slider.max)).toBe(N - 1); // one step per stored sample
    fireEvent.change(slider, { target: { value: "10" } });
    const want = new Date(T0 + 10 * 60_000).toISOString();
    await waitFor(() => expect(straddleCalls().some((u) => u.includes(`as_of=${want}`) && u.includes("session=2026-11-11"))).toBe(true), { timeout: 5000 });
    expect(screen.getByTestId("replay-time")).toHaveTextContent("09:26 IST"); // 09:16 + 10 minutes
    await waitFor(() => expect(screen.getByTestId("sdi-as-of")).toHaveTextContent("analysis as of 09:26"), { timeout: 5000 }); // the page says which minute the analysis is as of
    await userEvent.click(screen.getByRole("button", { name: "Exit replay" }));
    expect(screen.queryByRole("slider", { name: "Replay time" })).toBeNull();
    const before = straddleCalls().length;
    await waitFor(() => expect(straddleCalls().length).toBeGreaterThanOrEqual(before)); // the plain query is the live one again
    expect(straddleCalls().filter((u) => !u.includes("as_of")).length).toBeGreaterThan(0);
  });

  it("keeps one request in flight and asks for the newest time next, instead of one request per step", async () => {
    mount();
    delayMs = 400; // an analysis takes the server a while
    await userEvent.click(await screen.findByRole("button", { name: /Replay/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    const slider = (await screen.findByRole("slider", { name: "Replay time" })) as HTMLInputElement;
    for (const v of [2, 4, 6, 8, 10, 12, 14]) fireEvent.change(slider, { target: { value: String(v) } }); // seven steps while the first answer is still coming
    const last = new Date(T0 + 14 * 60_000).toISOString();
    await waitFor(() => expect(straddleCalls().some((u) => u.includes(`as_of=${last}`))).toBe(true), { timeout: 6000 }); // the newest time is asked for
    expect(straddleCalls().filter((u) => u.includes("as_of=")).length).toBeLessThanOrEqual(3); // not one request per step
  });
});
