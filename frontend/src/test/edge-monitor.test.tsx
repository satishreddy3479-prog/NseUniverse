// The Edge monitor, rendered from the report the backend builds out of the real stored sessions of 29 Oct to 25 Nov 2026 (18 sessions scored by the nightly job).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeMonitor } from "../components/intelligence/EdgeMonitor";
import { pct, pts } from "../lib/edge";
import type { EdgeReport } from "../lib/edge";
import reportJson from "./edge-report.json";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel, option }: { ariaLabel: string; option: { series?: { name?: string }[] } }) => <div role="img" aria-label={ariaLabel} data-series={(option.series ?? []).map((s) => s.name).join("|")} />,
}));

const report = reportJson as unknown as EdgeReport;

function mount(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EdgeMonitor /></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("the formatters keep a missing figure missing", () => {
  it("signs points, formats shares", () => {
    expect(pts(0.054)).toBe("+5.4 pts");
    expect(pts(-0.0551)).toBe("−5.5 pts");
    expect(pts(null)).toBe("—");
    expect(pct(0.598, 0)).toBe("60%");
    expect(pct(undefined)).toBe("—");
  });
});

describe("the Edge monitor", () => {
  it("opens with the plain answer and says how many sessions it rests on", async () => {
    mount(report);
    expect((await screen.findByTestId("edge-headline-text")).textContent).toBe(report.headline);
    expect(screen.getByTestId("edge-headline").textContent).toContain("18 sessions scored");
    expect(report.headline).toContain("20 are needed");
  });

  it("shows one card per indicator with its status, its figures and its progress", async () => {
    mount(report);
    await screen.findByTestId("edge-cards");
    for (const i of report.indicators) {
      const card = screen.getByTestId(`edge-card-${i.id}`);
      expect(within(card).getByText(i.name)).toBeTruthy();
      expect(screen.getByTestId(`edge-text-${i.id}`).textContent).toBe(i.status_text);
    }
    expect(report.indicators.map((i) => i.id)).toEqual(["verdict", "rules", "momentum", "orb", "seller"]);
    // nothing can be called proven yet: every label is "Too early"
    expect(screen.getAllByText("Too early")).toHaveLength(5);
  });

  it("a pattern found in the stored sessions shows 0 fresh sessions and says those cannot prove it", async () => {
    mount(report);
    const card = await screen.findByTestId("edge-card-momentum");
    expect(within(card).getByTestId("edge-progress").textContent).toContain("0 / 20");
    expect(within(card).getByTestId("edge-progress").textContent).toContain("fresh sessions since 2026-11-25");
    expect(screen.getByTestId("edge-text-momentum").textContent).toContain("cannot prove it");
    // the rules score was not tuned on these sessions: its progress counts the sessions scored
    expect(within(screen.getByTestId("edge-card-rules")).getByTestId("edge-progress").textContent).toContain("18 / 20");
  });

  it("shows a session-by-session view that follows the selected indicator", async () => {
    mount(report);
    await screen.findByTestId("edge-detail");
    expect(screen.getByTestId("edge-detail").textContent).toContain("Market Intelligence verdict: session by session");
    expect(screen.getByTestId("edge-insample").textContent).toContain("Not evidence");
    fireEvent.click(within(screen.getByTestId("edge-card-rules")).getByRole("button"));
    expect(screen.getByTestId("edge-detail").textContent).toContain("Intraday rules score: session by session");
    expect(screen.queryByTestId("edge-insample")).toBeNull(); // not tuned on stored data: no in-sample note
    const rows = within(screen.getByTestId("edge-sessions")).getAllByRole("row");
    expect(rows).toHaveLength(1 + report.indicators[1]!.horizons["30"]!.series.length); // header + one row a session, newest first
    expect(within(rows[1]!).getAllByRole("cell")[0]!.textContent).toBe("2026-11-25");
    expect(within(screen.getByTestId("edge-horizons")).getAllByRole("row")).toHaveLength(4); // header + 15, 30 and 60 minutes
    expect(screen.getByRole("img").getAttribute("data-series")).toBe("Right so far|Luck would give");
  });

  it("states the scoring job's own state, including a failure", async () => {
    mount({ ...report, job: { ...report.job, last_error: "2026-11-16: RuntimeError: boom", pending: ["2026-11-16"] } });
    const job = await screen.findByTestId("edge-job");
    expect(job.textContent).toContain("Scoring job running");
    expect(job.textContent).toContain("1 finished session(s) waiting");
    expect(screen.getByTestId("edge-job-error").textContent).toContain("boom");
  });

  it("has an empty state before anything is scored, and an error state when the report cannot load", async () => {
    mount({ ...report, sessions_scored: 0, first_session: null, last_session: null, headline: "No finished session has been scored yet.", indicators: [] });
    expect((await screen.findByTestId("edge-empty")).textContent).toContain("Nothing has been scored yet");
    expect(screen.queryByTestId("edge-cards")).toBeNull();
    vi.unstubAllGlobals();
    mount({ detail: "the edge scoring job is not running" }, 503);
    expect((await screen.findAllByRole("alert"))[0]!.textContent).toContain("could not be loaded");
  });
});
