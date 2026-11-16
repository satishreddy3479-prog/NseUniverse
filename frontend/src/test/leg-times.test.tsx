import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LegTimes } from "../components/LegTimes";
import { applyAutomation, exitLeg, fmtStamp, moveStopsToCost, reenterLeg, stripStamp, type Leg } from "../lib/strategy";

// The times of 16 Nov 2026 on the user's short 25300 straddle: entered 10:25:50 IST (04:55:50Z), the put stopped at 10:34:38 at 149.25.
const ENTERED = "2026-11-16T04:55:50.870Z";
const STOP_AT = "2026-11-16T05:04:38.876Z";
const put: Leg = { id: "p", expiry: "2026-11-17", strike: 25300, type: "PE", action: "SELL", lots: 1, premium: 106.2, premiumSource: "market", stop: 148.7, target: 60, enteredAt: ENTERED, stopSetAt: ENTERED, targetSetAt: ENTERED };

describe("leg timestamps", () => {
  it("formats IST with the date and strips the time an older log line starts with", () => {
    expect(fmtStamp(STOP_AT)).toBe("16 Nov, 10:34:38");
    expect(fmtStamp(null)).toBe("—");
    expect(stripStamp("10:34:38 Stop: SELL 25300 PE closed at 149.25")).toBe("Stop: SELL 25300 PE closed at 149.25");
    expect(stripStamp("16 Nov, 10:34:38 Stop: SELL 25300 PE closed at 149.25")).toBe("Stop: SELL 25300 PE closed at 149.25");
    expect(stripStamp("Re-entry: SELL 25300 PE at 100.00")).toBe("Re-entry: SELL 25300 PE at 100.00");
  });

  it("an exit is written with its date and time, the exit time is kept", () => {
    const out = exitLeg(put, 149.25, "stop", 65, STOP_AT);
    expect(out.exitedAt).toBe(STOP_AT);
    expect(out.log![0]!.text).toBe("16 Nov, 10:34:38 Stop: SELL 25300 PE closed at 149.25 (entry 106.20), −₹2,798");
    expect(out.log![0]!.at).toBe(STOP_AT);
  });

  it("the trailing stop writes each move with its time, and moves the stop-set time", () => {
    // sold at 100, stop 140, trail: every 10% of the entry in favour move the stop 5%: at 80 the gain is 20% = 2 steps, stop 140 - 2 x 5 = 130
    const leg: Leg = { id: "t", expiry: "2026-11-17", strike: 25300, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", stop: 140, trailEvery: 10, trailBy: 5, enteredAt: ENTERED, stopSetAt: ENTERED };
    const at = "2026-11-16T06:00:00.000Z";
    const r = applyAutomation([leg], () => 80, 65, at);
    const l = r.legs[0]!;
    expect(l.stop).toBe(130);
    expect(l.stopSetAt).toBe(at);
    expect(l.log![l.log!.length - 1]).toEqual({ at, text: "16 Nov, 11:30:00 Trailing stop: SELL 25300 CE stop 140.00 → 130.00 (price 80.00)" });
    expect(r.events).toHaveLength(1); // the strategy's event count (used by the server parity check) is unchanged
  });

  it("a re-entry and a stop moved to cost set their times", () => {
    const stopped = exitLeg({ ...put, reentry: 1, stopPct: 0.4, targetPct: 0.43 }, 149.25, "stop", 65, STOP_AT);
    const at = "2026-11-16T06:30:00.000Z";
    const again = reenterLeg(stopped, 106.2, at, true);
    expect(again.enteredAt).toBe(at);
    expect(again.stopSetAt).toBe(at);
    expect(again.targetSetAt).toBe(at);
    const call: Leg = { ...put, id: "c", type: "CE", premium: 94.7, stop: 132.6, target: null, enteredAt: ENTERED };
    const m = moveStopsToCost([call], [exitLeg(put, 149.25, "stop", 65, STOP_AT)], () => 80, at);
    expect(m.legs[0]!.stop).toBe(94.7);
    expect(m.legs[0]!.stopSetAt).toBe(at);
    expect(m.legs[0]!.log!.at(-1)!.text).toMatch(/^16 Nov, 12:00:00 Stop moved to cost/);
  });

  it("the leg shows when it was entered, when its stop and target were set, when it exited and every history line with its date", () => {
    const stopped = exitLeg(put, 149.25, "stop", 65, STOP_AT);
    render(<LegTimes leg={{ ...stopped, log: [{ at: STOP_AT, text: "10:34:38 Stop: SELL 25300 PE closed at 149.25 [server]" }] }} />);
    const text = screen.getByTestId("leg-times").textContent ?? "";
    expect(text).toContain("Entered 16 Nov, 10:25:50");
    expect(text).toContain("Stop set 148.70 · 16 Nov, 10:25:50");
    expect(text).toContain("Target set 60.00 · 16 Nov, 10:25:50");
    expect(text).toContain("Exited 16 Nov, 10:34:38 at 149.25 (stop)");
    expect(screen.getByTestId("leg-log")).toHaveTextContent("16 Nov, 10:34:38 · Stop: SELL 25300 PE closed at 149.25 [server]");
  });

  it("a leg saved before it kept an entry time uses the strategy start and says so; with neither it says the time was not recorded; a moved stop is labelled as moved", () => {
    const old: Leg = { ...put, enteredAt: undefined, stopSetAt: undefined, targetSetAt: undefined, stopTrailed: true };
    const { rerender } = render(<LegTimes leg={old} startedAt={ENTERED} />);
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Entered 16 Nov, 10:25:50 (strategy last started)");
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Stop moved 148.70 · 16 Nov, 10:25:50");
    rerender(<LegTimes leg={{ ...old, exitPrice: 149.25, exitedAt: "2026-11-16T05:04:38.876Z" }} startedAt="2026-11-16T08:38:43.908Z" />);
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Entered time not recorded"); // the strategy was restarted after this leg exited: that cannot be its entry
    rerender(<LegTimes leg={old} />);
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Entered time not recorded");
    rerender(<LegTimes leg={{ ...old, stop: null, target: null }} startedAt={ENTERED} />);
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Stop none");
    expect(screen.getByTestId("leg-times")).toHaveTextContent("Target none");
  });

  it("older history lines are folded under a count", () => {
    const log = Array.from({ length: 6 }, (_, i) => ({ at: `2026-11-16T05:0${i}:00.000Z`, text: `x ${i}` }));
    render(<LegTimes leg={{ ...put, log }} />);
    expect(screen.getByText("3 earlier lines")).toBeInTheDocument();
  });
});
