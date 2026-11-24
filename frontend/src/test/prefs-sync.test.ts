// Preferences follow the owner across browsers and PCs: a fake server (the /api/prefs contract) and "devices" that are a cleared localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPrefs, hydratePrefs, installPrefsSync, isSynced, uninstallPrefsSync } from "../lib/prefs";

interface Row { value: string | null; updatedAt: string }
let server: Record<string, Row>;
let tick: number;
let down: boolean;
const calls: string[] = [];

function fakeServer() {
  server = {}; tick = 0; down = false; calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${decodeURIComponent(url)}`);
    if (down) throw new TypeError("offline");
    const stamp = () => `2026-11-24T05:00:${String(++tick).padStart(2, "0")}Z`;
    if (url === "/api/prefs") return new Response(JSON.stringify({ prefs: server }), { status: 200 });
    const key = decodeURIComponent(url.replace("/api/prefs/", ""));
    if (init?.method === "PUT") {
      const value = (JSON.parse(String(init.body)) as { value: string }).value;
      if (server[key]?.value !== value) server[key] = { value, updatedAt: stamp() };
      return new Response(JSON.stringify(server[key]), { status: 200 });
    }
    if (init?.method === "DELETE") { server[key] = { value: null, updatedAt: stamp() }; return new Response(JSON.stringify(server[key]), { status: 200 }); }
    return new Response("{}", { status: 404 });
  }));
}
/** Another browser or PC: nothing stored, the same server. */
const newDevice = () => { uninstallPrefsSync(); localStorage.clear(); };

beforeEach(fakeServer);
afterEach(() => { uninstallPrefsSync(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("which keys are shared", () => {
  it("shares layouts and choices, not strategies, the builder's working copy or the module's own bookkeeping", () => {
    for (const k of ["nse.layout.v1.vega", "nse.smartoi.layout.v1", "nse.timeframe.v1", "nse.charts.hideInfo", "nse.portfolio.capital.v1", "nse-universe.theme", "newsSeenAt", "nse.analysis.layout.v1"]) expect(isSynced(k), k).toBe(true);
    for (const k of ["nse.strategies.v1", "nse.closed.v1", "nse.builder.working.v1", "nse.builder.temp.v1", "nse.builder.open-closed.v1", "nse.prefs.sync.v1", "nse.layout.v1.probe", "other.key", "token"]) expect(isSynced(k), k).toBe(false);
  });
});

describe("one owner, two devices", () => {
  it("a layout saved on the laptop appears on the other PC", async () => {
    // laptop
    await hydratePrefs();
    installPrefsSync();
    localStorage.setItem("nse.layout.v1.trend-opening-range", '{"tf":15}');
    expect(await flushPrefs()).toBe(true);
    expect(server["nse.layout.v1.trend-opening-range"]!.value).toBe('{"tf":15}');
    // the working PC, first visit
    newDevice();
    const r = await hydratePrefs();
    expect(r).toMatchObject({ ok: true, applied: 1 });
    expect(localStorage.getItem("nse.layout.v1.trend-opening-range")).toBe('{"tf":15}');
  });

  it("a change on one device replaces the older copy on the other, and a removal reaches it too", async () => {
    await hydratePrefs(); installPrefsSync();
    localStorage.setItem("nse.timeframe.v1", "5");
    await flushPrefs();
    // second device picks it up and then changes it
    const laptopStore = { ...localStorage };
    newDevice();
    await hydratePrefs(); installPrefsSync();
    expect(localStorage.getItem("nse.timeframe.v1")).toBe("5");
    localStorage.setItem("nse.timeframe.v1", "15");
    await flushPrefs();
    // back on the laptop (its old meta restored): the newer server value comes in
    newDevice();
    for (const [k, v] of Object.entries(laptopStore)) localStorage.setItem(k, v);
    localStorage.setItem("nse.prefs.sync.v1", JSON.stringify({ "nse.timeframe.v1": { at: "2026-11-24T05:00:01Z", dirty: false } }));
    await hydratePrefs(); installPrefsSync();
    expect(localStorage.getItem("nse.timeframe.v1")).toBe("15");
    // the laptop resets it: the removal is sent, and the other PC drops its copy instead of sending it back
    localStorage.removeItem("nse.timeframe.v1");
    await flushPrefs();
    expect(server["nse.timeframe.v1"]!.value).toBeNull();
    const meta = localStorage.getItem("nse.prefs.sync.v1");
    newDevice();
    localStorage.setItem("nse.timeframe.v1", "15");
    localStorage.setItem("nse.prefs.sync.v1", JSON.stringify({ "nse.timeframe.v1": { at: "2026-11-24T05:00:02Z", dirty: false } }));
    await hydratePrefs();
    expect(localStorage.getItem("nse.timeframe.v1")).toBeNull();
    expect(server["nse.timeframe.v1"]!.value).toBeNull(); // not resurrected
    expect(meta).not.toBeNull();
  });

  it("first use: what a browser holds is uploaded when the server has none, and the server's copy wins when it has one", async () => {
    localStorage.setItem("nse.layout.v1.gamma", '{"a":1}');
    localStorage.setItem("nse.layout.v1.vega", '{"b":2}');
    server["nse.layout.v1.vega"] = { value: '{"b":9}', updatedAt: "2026-11-24T04:00:00Z" };
    const r = await hydratePrefs();
    expect(r.pushed).toBe(1);
    expect(localStorage.getItem("nse.layout.v1.vega")).toBe('{"b":9}'); // the shared copy
    await vi.waitFor(() => expect(server["nse.layout.v1.gamma"]?.value).toBe('{"a":1}')); // the uploaded one
  });

  it("an unsent change on this browser wins over the server's copy and is sent", async () => {
    server["nse.timeframe.v1"] = { value: "3", updatedAt: "2026-11-24T04:00:00Z" };
    localStorage.setItem("nse.timeframe.v1", "1");
    localStorage.setItem("nse.prefs.sync.v1", JSON.stringify({ "nse.timeframe.v1": { at: "2026-11-24T03:00:00Z", dirty: true } }));
    await hydratePrefs();
    expect(localStorage.getItem("nse.timeframe.v1")).toBe("1");
    await vi.waitFor(() => expect(server["nse.timeframe.v1"]!.value).toBe("1"));
  });

  it("the app's own start-up write of an unchanged value is not a change", async () => {
    localStorage.setItem("nse-universe.theme", "dark");
    server["nse-universe.theme"] = { value: "dark", updatedAt: "2026-11-24T04:00:00Z" };
    await hydratePrefs(); installPrefsSync();
    calls.length = 0;
    localStorage.setItem("nse-universe.theme", "dark");
    expect(await flushPrefs()).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });

  it("never sends strategies or the builder's working copy", async () => {
    await hydratePrefs(); installPrefsSync();
    localStorage.setItem("nse.strategies.v1", "[]");
    localStorage.setItem("nse.builder.working.v1", "{}");
    localStorage.setItem("nse.closed.v1", "[]");
    await flushPrefs();
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });
});

describe("the server is away", () => {
  it("the app opens with this browser's values, keeps the unsent change and sends it later", async () => {
    down = true;
    localStorage.setItem("nse.layout.v1.vega", '{"old":1}');
    const r = await hydratePrefs(200);
    expect(r.ok).toBe(false);
    expect(localStorage.getItem("nse.layout.v1.vega")).toBe('{"old":1}'); // the page uses its own copy
    installPrefsSync();
    localStorage.setItem("nse.layout.v1.vega", '{"new":1}');
    expect(await flushPrefs()).toBe(false); // could not send, still unsent
    down = false;
    expect(await flushPrefs()).toBe(true);
    expect(server["nse.layout.v1.vega"]!.value).toBe('{"new":1}');
  });

  it("a change made again while it was being sent stays unsent", async () => {
    await hydratePrefs(); installPrefsSync();
    localStorage.setItem("nse.timeframe.v1", "1");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...a: Parameters<typeof fetch>) => { localStorage.setItem("nse.timeframe.v1", "3"); return real(...a); }));
    expect(await flushPrefs()).toBe(false);
    vi.stubGlobal("fetch", real);
    expect(await flushPrefs()).toBe(true);
    expect(server["nse.timeframe.v1"]!.value).toBe("3");
  });
});
