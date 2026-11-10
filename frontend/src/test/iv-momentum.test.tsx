// IV Momentum page renders what the backend computed; the numbers are formula checks (hand arithmetic), not market data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IvMomentumBody, momentumExample, momentumReading } from "../components/IvMomentum";
import { toolById } from "../lib/tools";
import type { IvMomentum, IvMomentumBucket, IvMomentumChange } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));
afterEach(() => vi.unstubAllGlobals());

const b = (o: Partial<IvMomentumBucket> = {}): IvMomentumBucket => ({ ce_now: null, ce_then: null, ce_change: null, pe_now: null, pe_then: null, pe_change: null, momentum: null, ...o });
const change = (d25: Partial<IvMomentumBucket>, from: string | null = "2026-11-09T09:25:00+05:30"): IvMomentumChange => ({ from, spot_change: 30, spot_change_pct: 0.125, atm: b(), d25: b(d25), d10: b() });
const data: IvMomentum = {
  status: "ok", expiry: "2026-11-10", session: "2026-11-09", tf_minutes: 1, samples_in_session: 3, previous_session: "2026-11-06", latest_at: "2026-11-09T09:30:00+05:30", age_seconds: 20, excluded: 0,
  table: {
    now: "2026-11-09T09:30:00+05:30",
    periods: { "1": change({}, null), "5": change({ ce_now: 13.6, ce_then: 13, ce_change: 0.6, pe_now: 15.2, pe_then: 15, pe_change: 0.2, momentum: 0.4 }), "15": change({}), "30": change({}), "60": change({}) },
    previous_close: null,
  },
  series: [{ at: "2026-11-09T09:25:00+05:30", spot: 24000, atm: { ce: 14, pe: 15 }, d25: { ce: 13, pe: 15 }, d10: { ce: null, pe: null } }], model: "Black-76", rate_assumed: 0.065,
};

describe("IV Momentum", () => {
  it("is a ready page tool and words the sign without claiming buying", () => {
    expect(toolById("iv-momentum")?.page).toBe("ivmomentum");
    expect(momentumReading(0.4)).toContain("call IV strengthened relative to put IV");
    expect(momentumReading(-0.4)).toContain("put IV strengthened");
    expect(momentumReading(0.02)).toContain("about the same");
    expect(momentumReading(null)).toContain("not available");
  });
  it("builds the worked example from the same numbers as the table", () => {
    const ex = momentumExample(data);
    expect(ex.join("\n")).toContain("CE IV change = 13.60 − 13.00 = +0.60 points");
    expect(ex.join("\n")).toContain("IV momentum = +0.60 − (+0.20) = +0.40 points");
  });
  it("shows the table with missing windows left missing, and the closed methodology panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IvMomentumBody expiry="2026-11-10" /></QueryClientProvider>);
    const table = await screen.findByTestId("ivmom-table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("1 min · no snapshot");
    expect(rows[2]!.textContent).toContain("+0.40");
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "10Δ" }));
    expect(within(screen.getByTestId("ivmom-table")).getAllByRole("row")[2]!.textContent).not.toContain("+0.40");
  });
});
