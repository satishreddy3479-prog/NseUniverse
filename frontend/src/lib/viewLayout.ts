/**
 * A page's saved view ("Save layout" and "Reset"): the choices a person makes on a page (a window, a delta, a range, what is shown) and which graphs they switched off in a chart's legend.
 * The page asks for each choice with ``use(name, standard)`` where it would have used ``useState(standard)``; the layout starts from what was saved (or the standard value) and the page
 * works exactly as before. Saved in this browser only, under ``nse.layout.v1.<page>``; the view and nothing else. A value that does not look like the standard one (another type)
 * is ignored when read back, so an old or edited entry cannot break a page. Things that name a day (an expiry, a session) are not meant to be saved: the page does not ask for them.
 */
import { useCallback, useRef, useState } from "react";
import { mergeOff } from "./smartOiLayout";

type Rec = Record<string, unknown>;
const keyOf = (page: string) => `nse.layout.v1.${page}`;

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Whether a saved value can stand in for the standard one: same kind, and for an object the same field names with values of the same kind. */
export function fits(saved: unknown, standard: unknown): boolean {
  if (kind(saved) !== kind(standard)) return false;
  if (kind(standard) === "number") return Number.isFinite(saved as number);
  if (kind(standard) === "object") {
    const a = saved as Rec, b = standard as Rec;
    return Object.keys(b).every((k) => k in a && fits(a[k], b[k]));
  }
  return true;
}
export function readSaved(page: string): Rec | null {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(page)) ?? "null") as unknown;
    return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
  } catch { return null; }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface ViewLayout {
  /** the choice ``name`` (``useState`` with a memory): the saved value when there is one and it fits, else the standard value */
  use: <T>(name: string, standard: T, initial?: T) => [T, (v: T | ((p: T) => T)) => void];
  /** props for an EChart: the graphs of that chart switched off stay off, and a click on its legend is remembered */
  legend: (chart: string) => { legendOff: string[]; onLegendChange: (sel: Record<string, boolean>) => void };
  saved: boolean;
  /** the view now differs from the saved one (or from the standard one when nothing is saved) */
  dirty: boolean;
  /** the view is not the standard one, or a layout is saved: there is something to reset */
  resettable: boolean;
  save: () => void;
  reset: () => void;
}

export function useViewLayout(page: string): ViewLayout {
  const [saved, setSaved] = useState<Rec | null>(() => readSaved(page));
  const [vals, setVals] = useState<Rec>(() => saved ?? {});
  const std = useRef<Rec>({});
  const ini = useRef<Rec>({}); // what a choice starts at when nothing was saved, if that is not the standard value
  const seen = useRef<string[]>([]);
  seen.current = []; // the names asked for in this render, in order
  const valsRef = useRef(vals);
  valsRef.current = vals;

  const use = useCallback(<T,>(name: string, standard: T, initial?: T): [T, (v: T | ((p: T) => T)) => void] => {
    std.current[name] = standard;
    ini.current[name] = initial === undefined ? standard : initial;
    seen.current.push(name);
    const raw = vals[name];
    const value = name in vals && fits(raw, standard) ? (raw as T) : ini.current[name] as T;
    const set = (v: T | ((p: T) => T)) => setVals((o) => {
      const cur = name in o && fits(o[name], standard) ? (o[name] as T) : ini.current[name] as T;
      const next = typeof v === "function" ? (v as (p: T) => T)(cur) : v;
      return same(next, cur) ? o : { ...o, [name]: next };
    });
    return [value, set];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals]);

  const legend = useCallback((chart: string) => {
    const name = `off:${chart}`;
    const [off] = use<string[]>(name, []);
    return {
      legendOff: off,
      onLegendChange: (sel: Record<string, boolean>) => setVals((o) => {
        const cur = Array.isArray(o[name]) ? (o[name] as string[]) : [];
        const next = mergeOff(cur, sel);
        return same(next, [...cur].sort()) ? o : { ...o, [name]: next };
      }),
    };
  }, [use]);

  // read when the bar renders, after the page has asked for all its choices in this render
  const current = (): Rec => {
    const out: Rec = {};
    for (const n of seen.current) { const s = std.current[n]; out[n] = n in vals && fits(vals[n], s) ? vals[n] : ini.current[n]; }
    return out;
  };
  const standardNow = (): Rec => Object.fromEntries(seen.current.map((n) => [n, std.current[n]]));
  const baseNow = (): Rec => (saved ? Object.fromEntries(seen.current.map((n) => [n, n in saved && fits(saved[n], std.current[n]) ? saved[n] : std.current[n]])) : standardNow());
  return {
    use, legend,
    saved: saved != null,
    get dirty() { return !same(current(), baseNow()); },
    get resettable() { return saved != null || !same(current(), standardNow()); },
    save: () => { const v = current(); try { localStorage.setItem(keyOf(page), JSON.stringify(v)); setSaved(v); } catch { /* storage unavailable: the view lasts for this visit */ } },
    reset: () => { try { localStorage.removeItem(keyOf(page)); } catch { /* nothing to remove */ } setSaved(null); setVals(standardNow()); }, // every choice goes to its standard value, also the ones that started somewhere else
  };
}
