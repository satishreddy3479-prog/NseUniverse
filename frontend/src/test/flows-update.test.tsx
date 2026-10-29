import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlowsUpdate } from "../components/FlowsUpdate";
import type { FlowsStatus } from "../lib/types";

const run = (at: string, trigger: string, ok = true, note: string | null = null, newest: string | null = "2026-10-28") => ({ at, trigger, ok, newest_session: newest, note });
const status = (over: Partial<FlowsStatus> = {}): FlowsStatus => ({
  enabled: true, running: false, progress: "", blocked: null, cash_note: null, source: "NSE", last_run: null,
  coverage: {
    fao_participant_oi: { first: "2026-10-19", last: "2026-10-28", files: 7, not_published_404: 0, last_stored_utc: null },
    fao_participant_vol: { first: null, last: null, files: 0, not_published_404: 0, last_stored_utc: null },
    fii_dii_cash: { first: "2026-10-28", last: "2026-10-29", files: 2, not_published_404: 0, last_stored_utc: null },
  },
  expected_session: "2026-10-29", missing_expected: ["participant_oi", "participant_vol"],
  components: {
    participant_oi: { last: run("2026-10-29T14:30:00Z", "auto", true, "0 new file(s); session 2026-10-29 not published yet"), last_auto_ok: run("2026-10-29T14:30:00Z", "auto"), last_manual_ok: null },
    cash: { last: run("2026-10-29T14:31:00Z", "manual", true, null, "2026-10-29"), last_auto_ok: null, last_manual_ok: run("2026-10-29T14:31:00Z", "manual", true, null, "2026-10-29") },
    participant_vol: { last: run("2026-10-29T14:30:00Z", "auto", false, "3 file(s) failed validation"), last_auto_ok: null, last_manual_ok: null },
  },
  ...over,
});
afterEach(() => vi.unstubAllGlobals());

function mount(s: FlowsStatus, posted: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { posted.push(String(input)); return new Response(JSON.stringify({ started: true, ...s }), { status: 200 }); }
    return new Response(JSON.stringify(s), { status: 200 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><FlowsUpdate components={["participant_oi", "participant_vol", "cash"]} s={s} /></QueryClientProvider>);
}

describe("flows Update now", () => {
  it("says which session is expected, what is missing and when each source was last checked", () => {
    mount(status());
    expect(screen.getByTestId("flows-expected")).toHaveTextContent("Newest session expected: 2026-10-29");
    expect(screen.getByTestId("flows-expected")).toHaveTextContent("Still missing: F&O participant open interest, F&O participant volume");
    const oi = screen.getByTestId("flows-run-participant_oi");
    expect(oi).toHaveTextContent("newest stored 2026-10-28");
    expect(oi).toHaveTextContent("last successful automatic check 29 Oct");
    expect(oi).toHaveTextContent("last manual update none yet");
    expect(oi).toHaveTextContent("session 2026-10-29 not published yet");
    expect(screen.getByTestId("flows-run-cash")).toHaveTextContent("last manual update 29 Oct");
  });

  it("shows a failed check as failed, never as a successful run", () => {
    mount(status());
    const vol = screen.getByTestId("flows-run-participant_vol");
    expect(vol).toHaveTextContent("last successful automatic check none yet");
    expect(vol).toHaveTextContent("last attempt failed: 3 file(s) failed validation");
  });

  it("says automatic checks have stopped once the newest session is stored", () => {
    mount(status({ missing_expected: [] }));
    expect(screen.getByTestId("flows-expected")).toHaveTextContent("automatic checks have stopped");
  });

  it("Update now starts a manual run and is disabled while one is running", async () => {
    const posted: string[] = [];
    const { unmount } = mount(status(), posted);
    await userEvent.click(within(screen.getByTestId("flows-update")).getByRole("button", { name: "Update now" }));
    await vi.waitFor(() => expect(posted).toEqual(["/api/prediction/flows/refresh"]));
    unmount();
    mount(status({ running: true }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });
});
