// The graph kept with a closed strategy: built from the stored one-minute history up to the close, joined to the live ticks, saved with the record. Hand sums in each test.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedMtm } from "../components/ClosedMtm";
import { buildClosedMtm, legsForMtm, liveMtmKey, mtmSince, readLiveTicks, thinPoints, toStored, type StoredMtm } from "../lib/closedMtm";
import type { Leg } from "../lib/strategy";

vi.mock("../components/EChart", () => ({
  useChartColors: () => ({ up: "#0f0", down: "#f00", brass: "#cb4", info: "#09f", muted: "#999", rule: "#333", paper: "#fff", slate: "#111" }),
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const EXP = "2026-11-24";
const at = (hm: string) => `2026-11-20T${hm}:00.000Z`;
const times = [at("03:50"), at("03:51"), at("03:52"), at("03:53"), at("03:54")];
const STRIKES = { underlying: "NIFTY", expiry: EXP, strikes: [25800], atm_strike: 25800, times, spot: [], ce_price: { "25800": [100, 100, 105, 110, 95] }, pe_price: { "25800": [90, 90, 85, 80, 92] }, ce_oi: {}, pe_oi: {}, ce_change: {}, pe_change: {} } as never;
type L = Leg & { exit?: number };
const leg = (o: Partial<L>): L => ({ id: "x", expiry: EXP, strike: 25800, type: "CE", action: "SELL", lots: 1, premium: 100, premiumSource: "market", enteredAt: at("03:50"), ...o }) as L;
const rec = (legs: L[], o: object = {}) => ({ id: "c1", name: "straddle", closedAt: at("03:53"), lotSize: 65, legs, ...o });
const fetchers = () => ({ strikes: vi.fn(async () => STRIKES), futures: vi.fn(async () => ({}) as never) });

describe("a closed strategy's legs for the graph", () => {
  it("a leg closed by Exit all books its result at the closing time: sold at 100, exited at 110 on 65 units = -650, plus -130 booked by an earlier cycle", () => {
    const [l] = legsForMtm(rec([leg({ exit: 110, realised: -130 })]));
    expect(l!.exitPrice).toBe(110);
    expect(l!.exitedAt).toBe(at("03:53"));
    expect(l!.realised).toBeCloseTo(-130 - 10 * 65, 8);
  });
  it("a leg a stop or a rule closed keeps its own booked P&L and exit time", () => {
    const [l] = legsForMtm(rec([leg({ exitPrice: 130, exitedAt: at("03:52"), realised: -1950 })]));
    expect(l!.realised).toBe(-1950);
    expect(l!.exitedAt).toBe(at("03:52"));
  });
  it("the key of the live ticks does not change when legs exit, and the history is asked from a minute before the first entry", () => {
    const open = [leg({ id: "a" }), leg({ id: "b", enteredAt: at("03:55") })];
    expect(mtmSince(open)).toBe("2026-11-20T03:49:00.000Z");
    expect(liveMtmKey(open)).toBe(liveMtmKey([{ ...open[0]!, exitPrice: 120 }, open[1]!]));
    expect(mtmSince([leg({ enteredAt: null })])).toBeNull();
  });
});

describe("thinning and storing", () => {
  it("keeps the first, last, highest and lowest when thinning to a few points, and rounds to paise", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ t: i, v: i === 17 ? 900 : i === 31 ? -700 : i }));
    const out = thinPoints(pts, 10);
    expect(out.length).toBeLessThan(25);
    expect(out[0]!.t).toBe(0);
    expect(out[out.length - 1]!.t).toBe(49);
    expect(out.some((p) => p.v === 900) && out.some((p) => p.v === -700)).toBe(true);
    expect(toStored([{ t: 1, v: 10.126 }], true, "stored").pnl).toEqual([10.13]);
  });
});

describe("building the graph from the stored history", () => {
  it("one sold call, sold 100: the stored prices 100, 100, 105, 110 give 0, 0, -325, -650 and the exit at 110 keeps -650; nothing after the close", async () => {
    const f = fetchers();
    const r = await buildClosedMtm(rec([leg({ exit: 110 })]), f as never);
    expect(r.reason).toBeNull();
    expect(r.mtm!.pnl).toEqual([0, 0, -325, -650, -650]); // the 03:54 sample (95) is read as the history runs a minute past the close, and the leg is out: it stays -650
    expect(r.mtm!.complete).toBe(true);
    expect(r.mtm!.source).toBe("stored");
    expect(f.strikes).toHaveBeenCalled();
  });
  it("the live ticks kept at closing are joined after the stored samples that came before them", async () => {
    const live = toStored([{ t: Date.parse(at("03:52")) + 30_000, v: -500 }, { t: Date.parse(at("03:53")), v: -650 }], false, "live");
    const r = await buildClosedMtm(rec([leg({ exit: 110 })], { mtm: live }), fetchers() as never);
    expect(r.mtm!.source).toBe("stored+live");
    expect(r.mtm!.pnl).toEqual([0, 0, -325, -500, -650]); // stored 03:50, 03:51, 03:52, then the two live ticks; the stored samples after the first live tick are not used
  });
  it("says why when there is no entry time, or the stored prices cannot be read", async () => {
    expect((await buildClosedMtm(rec([leg({ enteredAt: null, exit: 110 })]), fetchers() as never)).reason).toMatch(/recorded entry time/);
    const down = { strikes: vi.fn(async () => { throw new Error("offline"); }), futures: fetchers().futures };
    expect((await buildClosedMtm(rec([leg({ exit: 110 })]), down as never)).reason).toMatch(/could not be read \(offline\)/);
  });
});

describe("the graph on screen", () => {
  beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
  const saved: StoredMtm = { t: [1000, 2000, 3000, 4000], pnl: [0, 300, -200, 150], complete: true, source: "stored", savedAt: "2026-11-23T10:00:00Z" };
  it("shows a saved graph with its high, low and drawdown (0, 300, -200, 150: high 300, low -200, drawdown 500) and builds nothing", async () => {
    const onSaved = vi.fn();
    render(<ClosedMtm c={rec([leg({ exit: 110 })], { mtm: saved })} onSaved={onSaved} />);
    const box = await screen.findByTestId("closed-mtm");
    expect(box).toHaveTextContent("+₹300");
    expect(box).toHaveTextContent("−₹200");
    expect(box).toHaveTextContent("−₹500");
    expect(box).toHaveTextContent("At the close+₹150");
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("a record with no graph is built from the stored history, shown, and handed back to be saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL) => (String(u).includes("strike-series") ? new Response(JSON.stringify(STRIKES), { status: 200 }) : new Response("{}", { status: 404 }))));
    const onSaved = vi.fn();
    render(<ClosedMtm c={rec([leg({ exit: 110 })])} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByTestId("closed-mtm")).toHaveTextContent("−₹650"));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((onSaved.mock.calls[0]![0] as StoredMtm).pnl).toEqual([0, 0, -325, -650, -650]);
  });
  it("with no stored history it says so and draws nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    render(<ClosedMtm c={rec([leg({ exit: 110 })])} />);
    expect(await screen.findByTestId("closed-mtm-reason")).toBeInTheDocument();
  });
  it("reads the live ticks the page kept, ignoring a broken one", () => {
    sessionStorage.setItem(liveMtmKey([leg({ id: "k1" })]), JSON.stringify([{ t: 1, v: 5 }, { t: "x", v: 3 }]));
    expect(readLiveTicks([leg({ id: "k1" })])).toEqual([{ t: 1, v: 5 }]);
  });
});
