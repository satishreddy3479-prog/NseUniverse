// On a holiday or the morning after an expiry the new weekly has no stored session: the tool pages open on the monthly (which has the last
// session) and say so, until the user picks an expiry. Chart options also shrink their margins on a narrow container, with no animation.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import { fitNarrow } from "../components/EChart";
import { expiries, status, summary } from "./fixtures";

function mockApi(last: Record<string, string> | undefined) {
  const routes: Record<string, unknown> = {
    "/api/status": status(), "/api/expiries": { ...expiries, last_session: last }, "/api/snapshots": [summary()], "/api/sessions": [], "/api/errors": [],
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
const renderAt = (path: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("expiry without a stored session", () => {
  it("opens on the monthly and says why, and the user can still pick the weekly", async () => {
    expect(expiries.weekly).toBeTruthy();
    mockApi({ [expiries.monthly!]: "2026-11-09" }); // only the monthly has a stored session
    renderAt("/tools/vega-analysis");
    const note = await screen.findByTestId("expiry-fallback");
    expect(note).toHaveTextContent("has no stored session yet");
    expect(note).toHaveTextContent("2026-11-09");
    expect(screen.getByRole("button", { name: /Monthly/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Weekly/ }));
    expect(screen.getByRole("button", { name: /Weekly/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("expiry-fallback")).toBeNull(); // the user's pick is never overridden
  });
  it("stays on the weekly when it has a stored session, or when nothing is known", async () => {
    mockApi({ [expiries.weekly!]: "2026-11-09", [expiries.monthly!]: "2026-11-09" });
    renderAt("/tools/vega-analysis");
    expect(await screen.findByRole("button", { name: /Weekly/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("expiry-fallback")).toBeNull();
  });
});

describe("chart fitting", () => {
  const opt = { grid: { left: 58, right: 132, top: 34 }, yAxis: [{ position: "left" }, { position: "right", axisLabel: { margin: 70 } }], series: [{ endLabel: { show: true, fontSize: 11, offset: [4, 0] } }] };
  it("caps the margins, hides far-pushed right-axis numbers and shrinks the tags on a narrow container", () => {
    const o = fitNarrow(opt as never, 375) as typeof opt & { yAxis: { axisLabel?: { show?: boolean } }[]; series: { endLabel: { fontSize: number } }[] };
    expect(o.grid).toMatchObject({ left: 46, right: 54, top: 34 }); // a chart whose right margin only holds latest-value tags needs the tag width, not the desktop margin
    expect(o.yAxis[1]!.axisLabel!.show).toBe(false);
    expect(o.series[0]!.endLabel.fontSize).toBe(10);
  });
  it("leaves a wide container's option unchanged", () => {
    expect(fitNarrow(opt as never, 900)).toBe(opt);
  });
});
