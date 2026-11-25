/**
 * The Eagles view board: which widgets are on it, in which boxes. Pure functions, no React: a person can put the same widget on the board as many times as they like,
 * so every box has its own key (``<widget>~<n>``) and the widget it shows is ``cat``. A layout that was saved is read back field by field; a widget that no longer
 * exists is dropped, a box that is missing is made, nothing else is guessed. Only the view is kept (in this browser), never any data.
 */
export const EAGLE_KEY = "nse.eagles.layout.v1";
export const GRID_COLS = 12;

export interface EagleItem { key: string; cat: string }
export interface Box { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export interface EagleBoard { items: EagleItem[]; layout: Box[]; next: number }
/** What the board needs to know about a widget to give it a box. */
export interface Size { w: number; h: number; minW: number; minH: number }

export const emptyBoard = (): EagleBoard => ({ items: [], layout: [], next: 1 });
const bottom = (layout: readonly Box[]) => layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
const clampInt = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Add one more box of a widget at the bottom of the board; the same widget may be added again and again. */
export function addItem(b: EagleBoard, cat: string, size: Size): EagleBoard {
  const key = `${cat}~${b.next}`;
  return { items: [...b.items, { key, cat }], layout: [...b.layout, { i: key, x: 0, y: bottom(b.layout), w: size.w, h: size.h, minW: size.minW, minH: size.minH }], next: b.next + 1 };
}

/** A copy of a box: the same widget, the same size, placed right under the original. */
export function duplicateItem(b: EagleBoard, key: string, size: Size): EagleBoard {
  const src = b.items.find((x) => x.key === key);
  if (!src) return b;
  const box = b.layout.find((l) => l.i === key);
  const next = addItem(b, src.cat, size);
  if (!box) return next;
  const added = next.layout[next.layout.length - 1]!;
  return { ...next, layout: [...next.layout.slice(0, -1), { ...added, w: box.w, h: box.h, x: box.x, y: box.y + box.h }] };
}

export const removeItem = (b: EagleBoard, key: string): EagleBoard => ({ ...b, items: b.items.filter((x) => x.key !== key), layout: b.layout.filter((l) => l.i !== key) });

/** The grid reports every box after a drag or a resize; keep only the boxes of widgets that are on the board. */
export function withLayout(b: EagleBoard, next: readonly Box[]): EagleBoard {
  const on = new Set(b.items.map((x) => x.key));
  const layout = next.filter((l) => on.has(l.i)).map((l) => ({ ...l }));
  return JSON.stringify(layout) === JSON.stringify(b.layout) ? b : { ...b, layout };
}

/** A starting board: the widgets in order, packed left to right in rows of 12 columns. */
export function starterBoard(cats: readonly string[], sizeOf: (cat: string) => Size | undefined): EagleBoard {
  let b = emptyBoard();
  let x = 0, y = 0, rowH = 0;
  for (const cat of cats) {
    const s = sizeOf(cat);
    if (!s) continue;
    if (x + s.w > GRID_COLS) { x = 0; y += rowH; rowH = 0; }
    b = addItem(b, cat, s);
    const last = b.layout[b.layout.length - 1]!;
    b.layout[b.layout.length - 1] = { ...last, x, y };
    x += s.w;
    rowH = Math.max(rowH, s.h);
  }
  return b;
}

/** A saved board read back; null when nothing usable was saved. ``sizeOf`` is undefined for a widget that no longer exists. */
export function parseBoard(raw: string | null, sizeOf: (cat: string) => Size | undefined): EagleBoard | null {
  if (!raw) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (v == null || typeof v !== "object" || !Array.isArray(v.items)) return null;
  const seen = new Set<string>();
  const items: EagleItem[] = [];
  for (const it of v.items as unknown[]) {
    const o = it as Partial<EagleItem> | null;
    if (!o || typeof o.key !== "string" || typeof o.cat !== "string" || seen.has(o.key) || !sizeOf(o.cat)) continue;
    seen.add(o.key);
    items.push({ key: o.key, cat: o.cat });
  }
  const boxes = Array.isArray(v.layout) ? (v.layout as Partial<Box>[]) : [];
  const layout: Box[] = [];
  for (const it of items) {
    const s = sizeOf(it.cat)!;
    const b = boxes.find((l) => l && l.i === it.key);
    layout.push(b
      ? { i: it.key, x: clampInt(b.x, 0, GRID_COLS - 1, 0), y: clampInt(b.y, 0, 100_000, bottom(layout)), w: clampInt(b.w, 1, GRID_COLS, s.w), h: clampInt(b.h, 1, 200, s.h), minW: s.minW, minH: s.minH }
      : { i: it.key, x: 0, y: bottom(layout), w: s.w, h: s.h, minW: s.minW, minH: s.minH });
  }
  const highest = items.reduce((m, it) => Math.max(m, Number(it.key.split("~")[1]) || 0), 0);
  return { items, layout, next: Math.max(clampInt(v.next, 1, 1_000_000, 1), highest + 1) };
}

export function loadBoard(sizeOf: (cat: string) => Size | undefined): EagleBoard | null {
  try { return parseBoard(localStorage.getItem(EAGLE_KEY), sizeOf); } catch { return null; }
}
export function saveBoard(b: EagleBoard): boolean {
  try { localStorage.setItem(EAGLE_KEY, JSON.stringify(b)); return true; } catch { return false; }
}

/** The title of a box: the widget's own, with a number when the same widget is on the board more than once (in the order they were added). */
export function titleOf(b: EagleBoard, key: string, title: string): string {
  const cat = b.items.find((x) => x.key === key)?.cat;
  const same = b.items.filter((x) => x.cat === cat);
  return same.length > 1 ? `${title} #${same.findIndex((x) => x.key === key) + 1}` : title;
}

/** How many boxes of a widget are on the board. */
export const countOf = (b: EagleBoard, cat: string): number => b.items.filter((x) => x.cat === cat).length;

/**
 * Auto-fit: no gaps. The boxes are packed in reading order, each into the lowest free place it fits (so a short box next to a tall one no longer leaves a hole under it),
 * then each box is widened into free space on its right and heightened into free space under it, up to the bottom of the board. A hole that no box can grow into (a gap
 * with an item on every side that is blocked) is left; nothing is ever made smaller than a box's own minimum, and nothing overlaps. Running it on its own result changes nothing.
 */
/** How tall a box may be, in grid rows, at its current width: it is not made taller than ``soft`` to fill a hole unless nothing else can, and never taller than ``hard``. */
export interface Limit { soft: number; hard: number }
export type LimitOf = (b: Box) => Limit | undefined;

export function fitLayout(layout: readonly Box[], cols = GRID_COLS, limit?: LimitOf): Box[] {
  // The boxes are packed in several orders (as they are read, tallest first, widest first, biggest first) and the packing with the fewest empty cells wins, the shortest on a tie.
  // A box that grew may pack differently the next time, so the result is fitted again until it stops changing (or comes back to one already seen): fitting a fitted layout changes nothing.
  const score = (l: readonly Box[]) => { const bottom = l.reduce((m, b) => Math.max(m, b.y + b.h), 0); return [cols * bottom - l.reduce((n, b) => n + b.w * b.h, 0), bottom]; };
  const best = (l: readonly Box[]): Box[] => {
    let top: Box[] | null = null, topScore: number[] = [];
    for (const order of ORDERS) {
      const got = fitOnce(l, cols, order, limit);
      const sc = score(got);
      if (!top || sc[0]! < topScore[0]! || (sc[0] === topScore[0] && sc[1]! < topScore[1]!)) { top = got; topScore = sc; }
    }
    return top!;
  };
  const seen = new Map<string, Box[]>();
  let cur = best(layout);
  for (let i = 0; i < 10; i++) {
    const key = JSON.stringify(cur);
    if (seen.has(key)) break;
    seen.set(key, cur);
    const next = best(cur);
    if (JSON.stringify(next) === key) return cur;
    cur = next;
  }
  return [...seen.values()].reduce((a, b) => { const sa = score(a), sb = score(b); return sb[0]! < sa[0]! || (sb[0] === sa[0] && sb[1]! < sa[1]!) ? b : a; });
}

type Order = (a: Box, b: Box) => number;
const reading: Order = (a, b) => a.y - b.y || a.x - b.x || a.i.localeCompare(b.i);
const ORDERS: Order[] = [
  reading, (a, b) => b.h - a.h || reading(a, b), (a, b) => b.w - a.w || reading(a, b), (a, b) => b.w * b.h - a.w * a.h || reading(a, b),
  (a, b) => a.h - b.h || reading(a, b), (a, b) => a.w - b.w || reading(a, b), (a, b) => a.w * a.h - b.w * b.h || reading(a, b), (a, b) => -reading(a, b),
  (a, b) => b.w - a.w || b.h - a.h || reading(a, b), (a, b) => a.x - b.x || a.y - b.y || a.i.localeCompare(b.i),
];

function fitOnce(layout: readonly Box[], cols: number, byOrder: Order, limit?: LimitOf): Box[] {
  const order = [...layout].sort(byOrder);
  const taken: boolean[][] = [];
  const free = (x: number, y: number, w: number, h: number) => {
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (taken[r]?.[c]) return false;
    return true;
  };
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let r = y; r < y + h; r++) { taken[r] ??= []; for (let c = x; c < x + w; c++) taken[r]![c] = true; }
  };
  const out: Box[] = [];
  for (const l of order) {
    const w = Math.min(cols, Math.max(1, l.w));
    const lim = limit?.({ ...l, w });
    // a box whose height is fixed (soft = hard: a whole tool as tall as its content, or one the person sized) takes exactly that; any other is cut back to the most it may be. Its own minimum wins.
    const h = Math.max(1, l.minH ?? 1, lim == null ? l.h : lim.soft === lim.hard ? lim.hard : Math.min(l.h, lim.hard));
    let placed = false;
    for (let y = 0; !placed; y++) {
      for (let x = 0; x + w <= cols; x++) if (free(x, y, w, h)) { out.push({ ...l, x, y, w, h }); mark(x, y, w, h); placed = true; break; }
    }
  }
  for (const b of out) { // widen into the free cells on the right, over the box's whole height
    while (b.x + b.w < cols && free(b.x + b.w, b.y, 1, b.h)) { mark(b.x + b.w, b.y, 1, b.h); b.w += 1; }
  }
  const end = out.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  // heighten into the free cells under, over the box's whole width, up to the bottom of the board: first every box up to its comfortable height, then, only where a hole is still
  // there, up to the most it may be (a chart box is never stretched past that, a whole tool is never taller than its content)
  for (const stage of ["soft", "hard"] as const) {
    for (const b of out) {
      const max = () => limit?.(b)?.[stage];
      while (b.y + b.h < end && (max() == null || b.h < max()!) && free(b.x, b.y + b.h, b.w, 1)) { mark(b.x, b.y + b.h, b.w, 1); b.h += 1; }
    }
  }
  return out.sort((a, b) => layout.findIndex((l) => l.i === a.i) - layout.findIndex((l) => l.i === b.i));
}

/** The board with its boxes fitted (see ``fitLayout``); the same board when they already fit. */
export function fitBoard(b: EagleBoard, limit?: LimitOf): EagleBoard {
  const layout = fitLayout(b.layout, GRID_COLS, limit);
  return JSON.stringify(layout) === JSON.stringify(b.layout) ? b : { ...b, layout };
}
