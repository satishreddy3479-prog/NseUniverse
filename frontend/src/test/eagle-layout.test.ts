// The Eagles view board as data (lib/eagle.ts) and the catalogue it draws from (components/eagle/catalog.tsx). Expected positions are counted by hand.
import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_BY_ID, STARTER, catalogGroups, sizeOf } from "../components/eagle/catalog";
import { WIDGETS } from "../components/dashboard/widgets";
import { addItem, countOf, duplicateItem, emptyBoard, fitBoard, fitLayout, parseBoard, removeItem, starterBoard, titleOf, withLayout, type Size } from "../lib/eagle";
import { TOOLS } from "../lib/tools";
import { TREND_VIEWS } from "../lib/trendViews";

const S: Record<string, Size> = { a: { w: 4, h: 9, minW: 3, minH: 5 }, b: { w: 4, h: 6, minW: 3, minH: 4 }, c: { w: 6, h: 10, minW: 3, minH: 6 }, wide: { w: 12, h: 8, minW: 4, minH: 4 } };
const size = (cat: string) => S[cat];

describe("adding, copying and removing boxes", () => {
  it("the same widget can be added again and again, each box with its own key", () => {
    let b = emptyBoard();
    b = addItem(b, "a", S.a!);
    b = addItem(b, "a", S.a!);
    b = addItem(b, "b", S.b!);
    expect(b.items.map((x) => x.key)).toEqual(["a~1", "a~2", "b~3"]);
    expect(countOf(b, "a")).toBe(2);
    expect(countOf(b, "c")).toBe(0);
    // each new box goes under the lowest one: y = the bottom of the board so far (the grid then packs it up)
    expect(b.layout.map((l) => [l.i, l.y])).toEqual([["a~1", 0], ["a~2", 9], ["b~3", 18]]);
    expect(b.next).toBe(4);
  });

  it("a copy has the size of the box it was made from and sits right under it", () => {
    let b = addItem(emptyBoard(), "a", S.a!);
    b = withLayout(b, [{ ...b.layout[0]!, w: 7, h: 12, x: 2, y: 3 }]); // the person resized and moved the first box
    const c = duplicateItem(b, "a~1", S.a!);
    expect(c.items.map((x) => x.key)).toEqual(["a~1", "a~2"]);
    expect(c.layout.find((l) => l.i === "a~2")).toMatchObject({ x: 2, y: 3 + 12, w: 7, h: 12 }); // right under: y = 3 + 12
    expect(duplicateItem(b, "nope", S.a!)).toBe(b); // a box that is not there is not copied
  });

  it("removing a box takes its place in the layout too, and the counter never reuses a key", () => {
    let b = addItem(addItem(emptyBoard(), "a", S.a!), "b", S.b!);
    b = removeItem(b, "a~1");
    expect(b.items.map((x) => x.key)).toEqual(["b~2"]);
    expect(b.layout.map((l) => l.i)).toEqual(["b~2"]);
    b = addItem(b, "a", S.a!);
    expect(b.items.map((x) => x.key)).toEqual(["b~2", "a~3"]); // not a~1 again
  });

  it("the grid's report keeps only the boxes that are on the board, and a report that changes nothing changes nothing", () => {
    const b = addItem(emptyBoard(), "a", S.a!);
    expect(withLayout(b, [...b.layout])).toBe(b);
    const next = withLayout(b, [{ ...b.layout[0]!, x: 4 }, { i: "ghost~9", x: 0, y: 0, w: 1, h: 1 }]);
    expect(next.layout).toHaveLength(1);
    expect(next.layout[0]!.x).toBe(4);
  });

  it("boxes of one widget are numbered in the order they were added, a lone box has no number", () => {
    let b = addItem(emptyBoard(), "a", S.a!);
    expect(titleOf(b, "a~1", "Alpha")).toBe("Alpha");
    b = addItem(addItem(b, "b", S.b!), "a", S.a!);
    expect(titleOf(b, "a~1", "Alpha")).toBe("Alpha #1");
    expect(titleOf(b, "a~3", "Alpha")).toBe("Alpha #2");
    expect(titleOf(b, "b~2", "Beta")).toBe("Beta");
  });
});

describe("the starter board", () => {
  it("is packed left to right in rows of 12 columns: 4 + 4 + 4, then a new row under the tallest, then 6 + 6", () => {
    const b = starterBoard(["a", "b", "a", "c", "c", "missing"], size);
    const at = b.layout.map((l) => [l.i, l.x, l.y]);
    // row 1: a (x0, h9), b (x4, h6), a (x8, h9) -> the row is 9 high; row 2 starts at y = 9: c (x0, h10), c (x6)
    expect(at).toEqual([["a~1", 0, 0], ["b~2", 4, 0], ["a~3", 8, 0], ["c~4", 0, 9], ["c~5", 6, 9]]);
    expect(b.items.some((x) => x.cat === "missing")).toBe(false); // a widget that does not exist is skipped
  });
  it("a wide box starts a row of its own", () => {
    const b = starterBoard(["a", "wide", "b"], size);
    expect(b.layout.map((l) => [l.i, l.x, l.y])).toEqual([["a~1", 0, 0], ["wide~2", 0, 9], ["b~3", 0, 17]]);
  });
});

describe("a saved board read back", () => {
  const raw = (v: unknown) => JSON.stringify(v);
  it("is returned as it was saved", () => {
    const b = starterBoard(["a", "b"], size);
    expect(parseBoard(raw(b), size)).toEqual(b);
  });
  it("is null when nothing usable was saved", () => {
    expect(parseBoard(null, size)).toBeNull();
    expect(parseBoard("not json", size)).toBeNull();
    expect(parseBoard(raw({ items: "x" }), size)).toBeNull();
    expect(parseBoard(raw(5), size)).toBeNull();
  });
  it("drops a widget that no longer exists and a repeated key, and makes a box that is missing", () => {
    const got = parseBoard(raw({ items: [{ key: "a~1", cat: "a" }, { key: "a~1", cat: "a" }, { key: "gone~2", cat: "gone" }, { key: "b~3", cat: "b" }, { cat: "b" }, null], layout: [{ i: "a~1", x: 4, y: 2, w: 5, h: 7 }], next: 4 }), size)!;
    expect(got.items.map((x) => x.key)).toEqual(["a~1", "b~3"]);
    expect(got.layout[0]).toMatchObject({ i: "a~1", x: 4, y: 2, w: 5, h: 7 });
    expect(got.layout[1]).toMatchObject({ i: "b~3", x: 0, y: 2 + 7, w: 4, h: 6 }); // b had no box: its default one, under the lowest (2 + 7)
  });
  it("keeps boxes inside the grid and never lets the counter hand out a key that is in use", () => {
    const got = parseBoard(raw({ items: [{ key: "a~7", cat: "a" }], layout: [{ i: "a~7", x: 99, y: -5, w: 99, h: 0 }], next: 2 }), size)!;
    expect(got.layout[0]).toMatchObject({ x: 11, y: 0, w: 12, h: 1 });
    expect(got.next).toBe(8); // the saved counter (2) was behind the highest key in use (7)
    expect(addItem(got, "a", S.a!).items.map((x) => x.key)).toEqual(["a~7", "a~8"]);
  });
});

describe("the catalogue", () => {
  it("has a unique id for every widget, and every one has a title, a group and a sane box", () => {
    expect(new Set(CATALOG.map((d) => d.id)).size).toBe(CATALOG.length);
    for (const d of CATALOG) {
      expect(d.title.length, d.id).toBeGreaterThan(0);
      expect(d.group.length, d.id).toBeGreaterThan(0);
      expect(d.w, d.id).toBeGreaterThanOrEqual(d.minW);
      expect(d.h, d.id).toBeGreaterThanOrEqual(d.minH);
      expect(d.w, d.id).toBeLessThanOrEqual(12);
      expect(sizeOf(d.id)).toBe(d);
    }
  });
  it("holds every option-chain widget of the Analysis page, every Trend & Regime view and every ready tool that has a page or a board of its own", () => {
    for (const w of WIDGETS) expect(CATALOG_BY_ID.has(`w:${w.id}`), w.id).toBe(true);
    for (const v of TREND_VIEWS) expect(CATALOG_BY_ID.has(`r:${v.id}`), v.id).toBe(true);
    const own = TOOLS.filter((t) => t.status === "ready" && !t.to && !t.tab && (t.board || t.page));
    expect(own.length).toBeGreaterThan(20);
    for (const t of own) expect(CATALOG_BY_ID.has(`t:${t.id}`), t.id).toBe(true);
    for (const id of ["s:mtm", "s:time"]) expect(CATALOG_BY_ID.get(id)?.charts, id).toBe(true);
    for (const id of ["i:day-board", "i:edge", "i:straddle"]) expect(CATALOG_BY_ID.has(id), id).toBe(true);
  });
  it("lists the chain widgets as fit-to-box and the whole tools as scrolling pages", () => {
    expect(CATALOG.filter((d) => d.id.startsWith("w:")).every((d) => d.kind === "fit")).toBe(true);
    expect(CATALOG.filter((d) => d.id.startsWith("t:") || d.id.startsWith("r:")).every((d) => d.kind === "page")).toBe(true);
  });
  it("the starting board only names widgets that exist, and fits in 12 columns", () => {
    for (const id of STARTER) expect(CATALOG_BY_ID.has(id), id).toBe(true);
    const b = starterBoard(STARTER, sizeOf);
    expect(b.items).toHaveLength(STARTER.length);
    expect(b.layout.every((l) => l.x + l.w <= 12)).toBe(true);
  });
  it("knows which widgets draw a chart, and Charts only leaves out the ones that are a table or text", () => {
    expect(CATALOG.every((d) => typeof d.charts === "boolean")).toBe(true);
    expect(CATALOG_BY_ID.get("w:chain")!.charts).toBe(false);
    expect(CATALOG_BY_ID.get("t:market-news")!.charts).toBe(false);
    expect(CATALOG_BY_ID.get("w:oi")!.charts && CATALOG_BY_ID.get("r:market-regime")!.charts && CATALOG_BY_ID.get("t:rolling-straddle")!.charts).toBe(true);
    const ids = (chartsOnly: boolean) => catalogGroups("", chartsOnly).flatMap((g) => g.defs.map((d) => d.id));
    expect(ids(true)).not.toContain("w:chain");
    expect(ids(false)).toContain("w:chain");
    expect(ids(true).length).toBe(CATALOG.filter((d) => d.charts).length);
    expect(ids(true).length).toBeGreaterThan(40); // the board stays rich: most tools have a chart
  });
  it("is searchable by title, group or what the widget says it is, and groups the rest", () => {
    const all = catalogGroups();
    expect(all[0]!.group).toBe("My strategy"); // the board's own tools first: the strategy that is running, then the intelligence
    expect(all.reduce((n, g) => n + g.defs.length, 0)).toBe(CATALOG.length);
    const hit = catalogGroups("rolling straddle").flatMap((g) => g.defs.map((d) => d.id));
    expect(hit).toContain("t:rolling-straddle");
    expect(catalogGroups("zzzz-no-such-widget")).toEqual([]);
  });
});

describe("auto-fit: no gaps", () => {
  const box = (i: string, x: number, y: number, w: number, h: number) => ({ i, x, y, w, h });
  const cells = (l: ReturnType<typeof fitLayout>) => l.flatMap((b) => Array.from({ length: b.w * b.h }, (_, k) => `${b.x + (k % b.w)},${b.y + Math.floor(k / b.w)}`));

  it("fills the holes by hand: 4 + 4 + 4 across and a 6-wide box leave no cell empty, whatever order wins", () => {
    // A 4x9, B 4x6, C 4x9 and D 6x10: 36 + 24 + 36 + 60 = 156 cells of the 12 x 13 = 156 they can cover exactly (D is 6 wide: it goes beside B and C, or under the row and widens)
    const got = fitLayout([box("A", 0, 0, 4, 9), box("B", 4, 0, 4, 6), box("C", 8, 0, 4, 9), box("D", 0, 50, 6, 10)]);
    const all = cells(got);
    expect(new Set(all).size).toBe(all.length); // no overlap
    const bottom = Math.max(...got.map((b) => b.y + b.h));
    expect(all.length).toBe(12 * bottom); // and not one empty cell above the bottom of the board
  });

  it("closes the enclosed hole seen on the real board (a 2 x 5 gap between three boxes that nothing could grow into)", () => {
    // the layout of the board on 25 Nov 2026 after the first auto-fit: 10 of its 816 cells were empty
    const seen = [box("day", 0, 0, 8, 22), box("regime", 0, 22, 6, 16), box("spot", 8, 0, 4, 9), box("oi", 6, 22, 6, 12), box("oiChange", 4, 43, 4, 9), box("straddle", 8, 9, 4, 13),
      box("pcr", 0, 38, 4, 14), box("gex", 8, 43, 4, 9), box("basis", 6, 34, 6, 9), box("rolling", 0, 52, 12, 16)];
    expect(new Set(cells(seen)).size).toBe(12 * 68 - 10);
    const got = fitLayout(seen);
    const all = cells(got);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(12 * Math.max(...got.map((b) => b.y + b.h)));
  });

  it("a later box goes into the hole under a short box instead of to the bottom", () => {
    const got = fitLayout([box("T", 0, 0, 4, 10), box("S1", 4, 0, 4, 4), box("S2", 8, 0, 4, 4), box("S3", 0, 30, 4, 4)]);
    expect(got.find((b) => b.i === "S3")).toMatchObject({ x: 4, y: 4 }); // under S1, not at y = 10
  });

  it("a box widens into free space on its right but never over another box, and the last row is not stretched past the bottom", () => {
    // A 3x8 and B 3x8 pack side by side at x = 0 and x = 3; B widens to the edge (to 9 wide); C is the last row, already at the bottom
    const got = fitLayout([box("A", 0, 0, 3, 8), box("B", 6, 0, 3, 8), box("C", 0, 8, 12, 4)]);
    expect(got.find((b) => b.i === "A")).toMatchObject({ x: 0, w: 3 });
    expect(got.find((b) => b.i === "B")).toMatchObject({ x: 3, w: 9 });
    expect(got.find((b) => b.i === "C")).toMatchObject({ y: 8, h: 4 });
  });

  it("never overlaps, never shrinks a box, and running it again changes nothing", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return (seed % n) + 1; };
    for (let round = 0; round < 40; round++) {
      const input = Array.from({ length: 1 + rnd(10) }, (_, k) => box(`k${k}`, rnd(12) - 1, rnd(30) - 1, rnd(8), rnd(12)));
      const got = fitLayout(input);
      const all = cells(got);
      expect(new Set(all).size, `round ${round}`).toBe(all.length); // no cell twice: no overlap
      for (const g of got) {
        const orig = input.find((b) => b.i === g.i)!;
        expect(g.w).toBeGreaterThanOrEqual(orig.w);
        expect(g.h).toBeGreaterThanOrEqual(orig.h);
        expect(g.x + g.w).toBeLessThanOrEqual(12);
      }
      expect(fitLayout(got)).toEqual(got);
    }
  });

  it("fitBoard returns the same board when it already fits, and a fitted one otherwise", () => {
    let b = addItem(addItem(emptyBoard(), "a", S.a!), "b", S.b!);
    b = fitBoard(b);
    expect(fitBoard(b)).toBe(b);
    expect(b.layout.map((l) => [l.i, l.x, l.y])).toEqual([["a~1", 0, 0], ["b~2", 4, 0]]);
  });
});
