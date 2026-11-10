import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { gexExample, GexUniversesSection } from "../components/dashboard/GexIntelligence";
import { black76, expiryEnd } from "../lib/optionModel";
import { gexUniverses } from "../lib/gexIntel";
import type { OptionChainRow } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: () => <div role="img" />,
}));
vi.mock("../components/dashboard/PriceBoards", () => ({ useSessionWindow: () => ({ since: null, until: null, day: null, controls: null }) }));

const EXPIRY = "2026-11-24";
const AT = expiryEnd(EXPIRY) - 0.1 * 365 * 86_400_000;
const q = (ltp: number, oi: number) => ({ ltp, oi }) as never;
const chain = [23800, 23900, 24000, 24100, 24200].map((k) => ({ strike: k, call: q(black76("CE", 24000, k, 0.1, 0.2, 0), 1_000_000), put: q(black76("PE", 24000, k, 0.1, 0.2, 0), 1_500_000) }) as OptionChainRow);

describe("GEX universes section", () => {
  it("lists fixed, dynamic and full separately with strike counts, and a sign-sensitivity table", () => {
    render(<GexUniversesSection rows={chain} spot={24000} expiry={EXPIRY} atMs={AT} openAtm={24100} />);
    for (const id of ["fixed", "dynamic", "full"]) expect(screen.getByTestId(`gex-universe-${id}`)).toBeTruthy();
    expect(screen.getByTestId("gex-universe-full").textContent).toContain("5 / 5");
    expect(within(screen.getByTestId("gex-scenarios")).getAllByRole("row")).toHaveLength(4);
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Dynamic ATM/ }));
    expect(screen.getByTestId("gex-universe-dynamic").className).toContain("bg-brass");
  });
  it("without an opening snapshot the fixed universe is omitted and says so", () => {
    render(<GexUniversesSection rows={chain} spot={24000} expiry={EXPIRY} atMs={AT} openAtm={null} />);
    expect(screen.queryByTestId("gex-universe-fixed")).toBeNull();
    expect(screen.getByTestId("gex-no-fixed")).toBeTruthy();
  });
  it("the worked example reproduces the strike's call GEX from its own gamma and OI", () => {
    const [u] = gexUniverses(chain, 24000, EXPIRY, AT, null, 2).slice(-1);
    const ex = gexExample(u);
    const r = u!.profile.rows.find((x) => ex[0]!.includes(`Strike ${x.strike} call`))!;
    expect(ex[1]).toContain(`= ${r.ce!.toFixed(2)} ₹ crore`);
    expect(r.ce).toBeCloseTo((r.ceGamma! * r.ceOi! * 24000 * 24000 * 0.01) / 1e7, 9);
  });
});
