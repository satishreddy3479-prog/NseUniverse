// The Eagles view page: the board, the picker, copies, removal and what is remembered. The widgets themselves are stood in for by small boxes (each is tested where it lives);
// the board logic, the persistence and the controls are the real ones.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EAGLE_KEY } from "../lib/eagle";
import { expiries, status } from "./fixtures";

vi.mock("../components/eagle/catalog", async () => {
  const mk = (id: string, title: string, group: string, kind: "fit" | "page", w = 4, h = 8, charts = true) => ({ id, title, group, kind, charts, blurb: `${title} blurb`, w, h, minW: 2, minH: 3, render: () => <div data-testid={`content-${id}`}>{title} content</div> });
  const defs = [mk("w:table", "Option chain table", "Snapshot and chain", "fit", 4, 8, false), mk("w:oi", "Open interest by strike", "Open interest", "fit"), mk("w:pcr", "Put-call ratio", "Put-call ratio", "fit"), mk("t:rolling", "ATM Rolling Straddle", "Price tools", "page", 6, 14), mk("i:day", "Day board", "Market Intelligence", "page", 8, 20), { ...mk("w:bad", "Broken widget", "Open interest", "fit"), render: (): React.ReactNode => { throw new Error("this widget is broken"); } }];
  const by = new Map(defs.map((d) => [d.id, d]));
  return {
    CATALOG: defs, CATALOG_BY_ID: by, sizeOf: (id: string) => by.get(id), STARTER: ["i:day", "w:oi"],
    catalogGroups: (q = "", chartsOnly = false) => {
      const all = chartsOnly ? defs.filter((d) => d.charts) : defs;
      const pool = q.trim() ? all.filter((d) => `${d.title} ${d.group}`.toLowerCase().includes(q.trim().toLowerCase())) : all;
      return [...new Set(pool.map((d) => d.group))].map((group) => ({ group, defs: pool.filter((d) => d.group === group) }));
    },
  };
});
vi.mock("react-grid-layout", () => ({
  GridLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="grid">{children}</div>,
  useContainerWidth: () => ({ width: 1400, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));
vi.mock("../components/LiveActivity", () => ({ StreamButtons: () => null }));

import { EaglesView } from "../pages/EaglesView";

function mount() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const routes: Record<string, unknown> = { "/api/status": status(), "/api/expiries": expiries };
    const hit = routes[String(input).split("?")[0]!];
    return hit === undefined ? new Response(JSON.stringify({ detail: { code: "nf", message: "nf" } }), { status: 404 }) : new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><EaglesView /></MemoryRouter></QueryClientProvider>);
}
const titles = () => screen.queryAllByTestId(/^eagle-box-/).map((e) => e.getAttribute("aria-label"));
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the Eagles view", () => {
  it("opens on the starter board, with the expiry and strike controls the widgets share", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Eagles view" })).toBeTruthy();
    expect(titles()).toEqual(["Day board", "Open interest by strike"]);
    expect(screen.getByTestId("eagle-count").textContent).toBe("2 widgets");
    expect(screen.getByRole("group", { name: "Expiry" })).toBeTruthy();
    expect(screen.getByLabelText("Strike range")).toBeTruthy();
  });

  it("any widget can be added from the picker, as many times as wanted, and the copies are numbered", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Add widgets/ }));
    const picker = screen.getByTestId("eagle-picker");
    expect(within(picker).getByText("Market Intelligence")).toBeTruthy(); // grouped
    await userEvent.click(within(picker).getByTestId("eagle-add-t:rolling"));
    await userEvent.click(within(picker).getByTestId("eagle-add-t:rolling"));
    expect(titles()).toEqual(["Day board", "Open interest by strike", "ATM Rolling Straddle #1", "ATM Rolling Straddle #2"]);
    expect(within(picker).getByTestId("eagle-n-t:rolling").textContent).toBe("×2"); // the picker says how many are on the board
    expect(screen.getByTestId("eagle-count").textContent).toBe("4 widgets");
  });

  it("the picker searches, says when nothing matches, and closes with Escape", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Add widgets/ }));
    const search = screen.getByRole("searchbox", { name: "Search widgets" });
    await userEvent.type(search, "pcr-nothing");
    expect(screen.getByRole("status").textContent).toContain("Nothing matches");
    await userEvent.clear(search);
    await userEvent.type(search, "put-call");
    expect(screen.queryByTestId("eagle-add-t:rolling")).toBeNull();
    expect(screen.getByTestId("eagle-add-w:pcr")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("eagle-picker")).toBeNull();
  });

  it("a box can be copied or removed from its own title bar", async () => {
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    await userEvent.click(screen.getByRole("button", { name: "Add another Open interest by strike" }));
    expect(titles()).toEqual(["Day board", "Open interest by strike #1", "Open interest by strike #2"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Open interest by strike #1" }));
    expect(titles()).toEqual(["Day board", "Open interest by strike"]); // the one left has no number again
    await userEvent.click(screen.getByRole("button", { name: "Remove Day board" }));
    expect(titles()).toEqual(["Open interest by strike"]);
  });

  it("each box draws its widget, and a page-sized tool scrolls inside its box while a chart widget fits it", async () => {
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(screen.getByTestId("content-i:day")).toBeTruthy();
    expect(screen.getByTestId("content-w:oi")).toBeTruthy();
    const key = (id: string) => (JSON.parse(localStorage.getItem(EAGLE_KEY) ?? "null") as { items: { key: string; cat: string }[] } | null)?.items.find((x) => x.cat === id)?.key;
    await userEvent.click(screen.getByRole("button", { name: "Add another Day board" }));
    expect(screen.getByTestId(`eagle-body-${key("i:day")}`).className).toContain("overflow-auto"); // a page: scrolls
    expect(screen.getByTestId(`eagle-body-${key("w:oi")}`).className).not.toContain("overflow-auto"); // a chart widget: fits
  });

  it("remembers the board in this browser: what was added and removed is there after the page is opened again", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /Add widgets/ }));
    await userEvent.click(screen.getByTestId("eagle-add-w:pcr"));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Day board" }));
    expect(titles()).toEqual(["Open interest by strike", "Put-call ratio"]);
    cleanup();
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(titles()).toEqual(["Open interest by strike", "Put-call ratio"]);
  });

  it("Starter board puts the first set back, and Clear board empties it with a plain message", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Clear board" }));
    expect(titles()).toEqual([]);
    expect(screen.getByTestId("eagle-empty").textContent).toContain("The board is empty");
    expect((screen.getByRole("button", { name: "Clear board" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Starter board" }));
    expect(titles()).toEqual(["Day board", "Open interest by strike"]);
  });

  it("Auto-fit leaves no gap: the boxes cover the board with no hole, and it can be switched off", async () => {
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    const layout = () => (JSON.parse(localStorage.getItem(EAGLE_KEY) ?? "null") as { layout: { i: string; x: number; y: number; w: number; h: number }[] } | null)?.layout ?? [];
    await userEvent.click(screen.getByRole("button", { name: "Add another Open interest by strike" })); // a change settles the board
    const before = layout();
    // no gap anywhere: the boxes together cover every cell of the 12-column board down to its bottom, each cell once
    const cells = before.flatMap((l) => Array.from({ length: l.w * l.h }, (_, k) => `${l.x + (k % l.w)},${l.y + Math.floor(k / l.w)}`));
    const bottom = before.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    expect(before).toHaveLength(3);
    expect(new Set(cells).size).toBe(cells.length);
    expect(cells.length).toBe(12 * bottom);
    expect(screen.getByTestId("eagle-autofit")).toBeChecked();
    await userEvent.click(screen.getByTestId("eagle-autofit"));
    expect(localStorage.getItem("nse.eagles.autofit.v1")).toBe("off");
  });

  it("Charts only is on by default: the board is marked for it, the picker lists only widgets with a chart, and the choice is remembered", async () => {
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(screen.getByTestId("eagle-board").className).toContain("eagle-co");
    expect(screen.getByTestId("eagle-charts-only")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /Add widgets/ }));
    expect(screen.getByTestId("eagle-picker-note").textContent).toContain("Charts only is on");
    expect(screen.queryByTestId("eagle-add-w:table")).toBeNull(); // a table-only tool is not offered
    expect(screen.getByTestId("eagle-add-w:oi")).toBeTruthy();
    await userEvent.click(screen.getByTestId("eagle-charts-only"));
    expect(screen.getByTestId("eagle-board").className).not.toContain("eagle-co");
    expect(localStorage.getItem("nse.eagles.charts.v1")).toBe("off");
    expect(screen.queryByTestId("eagle-picker-note")).toBeNull();
    expect(screen.getByTestId("eagle-add-w:table")).toBeTruthy(); // everything is offered again
    cleanup();
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(screen.getByTestId("eagle-charts-only")).not.toBeChecked(); // still off after the page is opened again
  });

  it("a box with no chart in Charts only mode says so, once its data had time to arrive, and does not when Charts only is off", async () => {
    localStorage.setItem(EAGLE_KEY, JSON.stringify({ items: [{ key: "w:table~1", cat: "w:table" }], layout: [{ i: "w:table~1", x: 0, y: 0, w: 4, h: 8 }], next: 2 }));
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect((await screen.findByTestId("eagle-nochart-w:table~1", undefined, { timeout: 4000 })).textContent).toContain("no chart");
    await userEvent.click(screen.getByTestId("eagle-charts-only"));
    expect(screen.queryByTestId("eagle-nochart-w:table~1")).toBeNull();
  });

  it("a saved board that names a widget which no longer exists opens without it", async () => {
    localStorage.setItem(EAGLE_KEY, JSON.stringify({ items: [{ key: "w:oi~1", cat: "w:oi" }, { key: "w:old~2", cat: "w:old" }], layout: [{ i: "w:oi~1", x: 0, y: 0, w: 4, h: 8 }], next: 3 }));
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(titles()).toEqual(["Open interest by strike"]);
  });

  it("one widget that breaks does not take the board down: the others keep drawing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined); // React reports the error it is about to contain
    localStorage.setItem(EAGLE_KEY, JSON.stringify({ items: [{ key: "w:bad~1", cat: "w:bad" }, { key: "w:oi~2", cat: "w:oi" }], layout: [{ i: "w:bad~1", x: 0, y: 0, w: 4, h: 8 }, { i: "w:oi~2", x: 4, y: 0, w: 4, h: 8 }], next: 3 }));
    mount();
    await screen.findByRole("heading", { name: "Eagles view" });
    expect(titles()).toEqual(["Broken widget", "Open interest by strike"]);
    expect(screen.getByTestId("content-w:oi")).toBeTruthy();
    expect(screen.queryByTestId("content-w:bad")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove Broken widget" })); // and it can still be taken off
    expect(titles()).toEqual(["Open interest by strike"]);
    quiet.mockRestore();
  });
});
