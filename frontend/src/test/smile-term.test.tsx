// Smile comparison between sessions and the full term structure: hand arithmetic on small fixtures (formula checks, not market data).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { compareExample, compareRows, SmileComparePanel, type SmileView } from "../components/SmileCompare";
import { termExample, TermStructureView } from "../components/TermStructureView";
import type { IvSkew, TermSeries } from "../lib/types";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const base = [
  { strike: 23900, side: "PE" as const, iv: 17, delta: -0.4 }, { strike: 23800, side: "PE" as const, iv: 18, delta: -0.26 }, { strike: 23600, side: "PE" as const, iv: 20, delta: -0.1 },
  { strike: 24100, side: "CE" as const, iv: 15, delta: 0.4 }, { strike: 24200, side: "CE" as const, iv: 14, delta: 0.24 }, { strike: 24400, side: "CE" as const, iv: 13.5, delta: 0.09 },
];
const view = (session: string, bump: number, atm: number): SmileView => ({ label: session, session, expiry: "2026-11-10", atmIv: atm, at: "2026-11-09T09:30:00Z", smile: base.map((p) => ({ ...p, iv: p.iv + bump })) });
const now = view("2026-11-09", 1, 16), then = view("2026-11-06", 0, 15);

describe("smile comparison", () => {
  it("each measure is the interpolated value of its own smile, and the change is now minus then", () => {
    const r = Object.fromEntries(compareRows(now, then).map((x) => [x.label, x]));
    expect(r["ATM IV"]!.diff).toBeCloseTo(1, 9);
    expect(r["25Δ call IV"]!.then).toBeCloseTo(14.0625, 4); // 14 + (0.25 − 0.24)/(0.40 − 0.24) × (15 − 14)
    expect(r["25Δ call IV"]!.now).toBeCloseTo(15.0625, 4);
    expect(r["25Δ call IV"]!.diff).toBeCloseTo(1, 9);
    expect(r["25Δ skew (put − call)"]!.diff).toBeCloseTo(0, 9); // both wings moved by the same amount
    expect(r["10Δ put IV"]!.then).toBeCloseTo(20, 9); // a contract exactly on 0.10
  });
  it("the worked example restates the interpolation and the change", () => {
    const ex = compareExample(now, then).join("\n");
    expect(ex).toContain("25Δ call IV = 14.00 + (0.25 − 0.240) / (0.400 − 0.240) × (15.00 − 14.00) = 14.063%");
    expect(ex).toContain("Change = 15.063 − 14.063 = 1.000 IV points");
  });
  it("lists every strike observation of both sessions, leaves a missing side missing, and says when there is nothing to compare with", () => {
    const sparse: SmileView = { ...then, smile: then.smile.filter((p) => p.strike !== 24200) };
    const picked: (string | null)[] = [];
    const { rerender } = render(<SmileComparePanel now={now} then={sparse} sessions={["2026-11-06", "2026-11-09"]} value="2026-11-06" onChange={(v) => picked.push(v)} loading={false} error={null} />);
    const rows = within(screen.getByTestId("smile-align")).getAllByRole("row");
    expect(rows).toHaveLength(1 + 6); // header + six strikes
    expect(rows.find((r) => r.textContent!.startsWith("24200"))!.textContent).toContain("—"); // the missing earlier observation stays missing
    fireEvent.change(screen.getByLabelText("Compare with session"), { target: { value: "" } });
    expect(picked).toEqual([null]);
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
    rerender(<SmileComparePanel now={now} then={null} sessions={["2026-11-09"]} value={null} onChange={() => {}} loading={false} error={null} />);
    expect(screen.getByTestId("smile-compare-none").textContent).toContain("nothing to compare");
  });
});

const ser = (near: [string, number, number], far: [string, number, number], slope: number, shape: TermSeries["shape"]): TermSeries => ({
  slope_per_30d: slope, shape, difference: far[2] - near[2], near: { expiry: near[0], days: near[1], value: near[2] }, far: { expiry: far[0], days: far[1], value: far[2] }, pairs: [], left_out: [],
});
const none: TermSeries = { slope_per_30d: null, shape: null, difference: null, near: null, far: null, pairs: [], left_out: [{ expiry: "2026-12-29", reason: "no call 10d iv" }] };
const term: IvSkew = {
  status: "ok", expiry: "2026-11-10", at: "2026-11-09T09:30:00Z", session: "2026-11-09", spot: 24000, atm_iv: 14, days: 1,
  term: [
    { expiry: "2026-11-10", days: 5, atm_iv: 14, skew_25d: 2.5, skew_10d: 5, call_25d_iv: 13, put_25d_iv: 15.5, call_10d_iv: 12, put_10d_iv: 17, slope_per_pct: null, butterfly_25d: null, butterfly_10d: null, call_minus_put_25d: null, call_minus_put_10d: null, put_25d_iv_: null } as never,
    { expiry: "2026-12-29", days: 35, atm_iv: 15, skew_25d: 1.5, skew_10d: null, call_25d_iv: 14.5, put_25d_iv: 16, call_10d_iv: null, put_10d_iv: 17.5, slope_per_pct: null, butterfly_25d: null, butterfly_10d: null, call_minus_put_25d: null, call_minus_put_10d: null } as never,
  ],
  term_structure: { slope_per_30d: 1, shape: "contango", near: null, far: null, pairs: [], left_out: [], series: {
    atm_iv: ser(["2026-11-10", 5, 14], ["2026-12-29", 35, 15], 1, "contango"), call_25d_iv: ser(["2026-11-10", 5, 13], ["2026-12-29", 35, 14.5], 1.5, "contango"),
    put_25d_iv: ser(["2026-11-10", 5, 15.5], ["2026-12-29", 35, 16], 0.5, "flat"), call_10d_iv: none, put_10d_iv: ser(["2026-11-10", 5, 17], ["2026-12-29", 35, 17.5], 0.5, "flat"),
    skew_25d: ser(["2026-11-10", 5, 2.5], ["2026-12-29", 35, 1.5], -1, "backwardation"), skew_10d: none,
  } },
} as unknown as IvSkew;

describe("term structure", () => {
  it("shows each series' slope with its near and far inputs, leaves a missing series missing, and reports what was left out", () => {
    render(<TermStructureView d={term} />);
    const calls = screen.getByTestId("term-slope-call_25d_iv").textContent!;
    expect(calls).toContain("+1.50"); // (14.50 − 13.00) / (35 − 5) × 30
    expect(calls).toContain("2026-11-10".slice(5) + ", 5.0d, 13.00");
    expect(screen.getByTestId("term-slope-atm_iv").textContent).toContain("contango");
    expect(screen.getByTestId("term-slope-skew_25d").textContent).toContain("backwardation");
    expect(screen.getByTestId("term-slope-call_10d_iv").textContent).toContain("—");
    expect(screen.getByTestId("term-slopes").textContent).toContain("2026-12-29 (no call 10d iv)");
    expect((screen.getByTestId("methodology") as HTMLDetailsElement).open).toBe(false);
  });
  it("the worked example restates the slope arithmetic", () => {
    const ex = termExample(term.term_structure!.series!).join("\n");
    expect(ex).toContain("ATM IV: (15.00 − 14.00) / (35.00 − 5.00) × 30 = +1.00 points per 30 days");
    expect(ex).toContain("25Δ call IV: (14.50 − 13.00) / (35.00 − 5.00) × 30 = +1.50");
  });
});
