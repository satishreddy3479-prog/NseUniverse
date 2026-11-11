// Participant-flow analysis: hand-calculated expectations on small explicit rows (inputs chosen so every result is checkable by eye).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ParticipantAnalysis } from "../components/ParticipantAnalysis";
import { classify, delta, headlines, legs, longShare, netBalance, netRank, optionBias, streak, ascending } from "../lib/participantFlow";
import type { FlowsDay } from "../lib/types";

// jsdom has no canvas: the chart wrapper becomes a stub that exposes what was plotted.
vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ option, ariaLabel }: { option: unknown; ariaLabel: string }) => {
    const o = option as { series?: { name?: string }[] };
    return <div role="img" aria-label={ariaLabel} data-series={(o.series ?? []).map((x) => x.name ?? "").join("|")} />;
  },
}));

const day = (session: string, fiiL: number, fiiS: number, cl: number, cs: number, callL = 100, callS = 300, putL = 500, putS = 200): FlowsDay => ({
  session,
  participants: {
    FII: { "Future Index Long": fiiL, "Future Index Short": fiiS, "Option Index Call Long": callL, "Option Index Call Short": callS, "Option Index Put Long": putL, "Option Index Put Short": putS },
    DII: { "Future Index Long": 100, "Future Index Short": 50 },
    Pro: { "Future Index Long": 200, "Future Index Short": 300 },
    Client: { "Future Index Long": cl, "Future Index Short": cs },
  },
});
// FII net index futures: -400, -300, -200, -100 (rising three steps); today long 600 short 700
const OI = [day("2026-11-05", 500, 900, 1000, 800), day("2026-11-06", 520, 820, 1000, 800), day("2026-11-09", 560, 760, 1000, 800), day("2026-11-11", 600, 700, 1000, 800)];

describe("participant flow maths", () => {
  it("net, long share, deltas and the kind of move", () => {
    expect(legs(OI[3], "FII", "idxFut")).toEqual({ long: 600, short: 700, net: -100 });
    expect(longShare({ long: 600, short: 700, net: -100 })).toBeCloseTo(600 / 1300);
    const d = delta(ascending(OI), "FII", "idxFut", 1)!; // 11-09 -> 11-11: long +40, short -60
    expect([d.dLong, d.dShort, d.dNet, d.kind, d.thenSession]).toEqual([40, -60, 100, "short_cover", "2026-11-09"]);
    const w = delta(ascending(OI), "FII", "idxFut", 3)!; // 11-05 -> 11-11: long +100, short -200
    expect([w.dLong, w.dShort, w.dNet, w.kind]).toEqual([100, -200, 300, "short_cover"]);
    expect(delta(ascending(OI), "FII", "idxFut", 4)).toBeNull(); // no session that far back
  });
  it("classifies by the bigger leg and calls tiny changes flat", () => {
    const base = { long: 1000, short: 1000, net: 0 };
    expect(classify({ long: 1200, short: 1000, net: 200 }, base)).toBe("long_build");
    expect(classify({ long: 800, short: 1000, net: -200 }, base)).toBe("long_unwind");
    expect(classify({ long: 1000, short: 1300, net: -300 }, base)).toBe("short_build");
    expect(classify({ long: 1000, short: 700, net: 300 }, base)).toBe("short_cover");
    expect(classify({ long: 1005, short: 1000, net: 5 }, base)).toBe("flat"); // 0.5% of the book
  });
  it("rank, streak, option bias and the cross-group balance", () => {
    const a = ascending(OI);
    expect(netRank(a, "FII", "idxFut")).toEqual({ rank: 4, of: 4, lowest: false, highest: true });
    expect(streak(a, "FII", "idxFut")).toBe(3);
    expect(optionBias(OI[3], "FII")).toBe((100 - 300) - (500 - 200)); // net calls -200, net puts +300 -> -500
    expect(netBalance(OI[3], "idxFut")).toBe(-100 + 50 + -100 + 200); // FII -100, DII +50, Pro -100, Client +200
    expect(legs({ session: "x", participants: { FII: {} } }, "FII", "idxFut")).toBeNull(); // missing stays missing
  });
  it("headlines quote the stored numbers", () => {
    const t = headlines(ascending(OI), [], 1).join(" ");
    expect(t).toContain("net short 100 index futures");
    expect(t).toContain("less short");
    expect(t).toContain("short covering");
    expect(t).toContain("risen for 3 sessions");
    expect(t).toContain("least short");
    expect(t).toContain("−500");
  });
});

describe("participant analysis panel", () => {
  it("says so when fewer than two sessions are stored", () => {
    render(<ParticipantAnalysis oi={[OI[0]!]} volume={[]} />);
    expect(screen.getByTestId("pa-short")).toHaveTextContent("1 stored");
  });
  it("shows the readout, the four groups and switches the comparison base and the group", async () => {
    render(<ParticipantAnalysis oi={[...OI].reverse()} volume={[]} />);
    expect(screen.getByRole("region", { name: "What is happening" })).toHaveTextContent("net short 100 index futures");
    const fii = screen.getByRole("button", { name: "FII positioning" });
    expect(fii).toHaveTextContent("-100");
    expect(fii).toHaveTextContent("+100"); // since the previous session
    await userEvent.click(screen.getByRole("button", { name: "vs 1 week (5 sessions)" }));
    expect(screen.getByText(/only 3 earlier sessions are stored: comparing with 2026-11-05/)).toBeInTheDocument();
    expect(fii).toHaveTextContent("+300");
    await userEvent.click(screen.getByRole("button", { name: "Client positioning" }));
    const t = screen.getByRole("table", { name: "Client positions today and before" });
    expect(within(t).getByText("Index futures")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Client index futures long, short and net by session" })).toHaveAttribute("data-series", "Long|Short|Net");
    // balance: -100 + 50 - 100 + 200 = +50
    expect(screen.getByTestId("pa-note")).toHaveTextContent("+50");
  });
});
