import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { CATALOG_BY_ID, STARTER, catalogGroups, sizeOf, type EagleDef } from "../components/eagle/catalog";
import { DashProvider, type Range } from "../components/dashboard/DashContext";
import { ReplayProvider } from "../components/dashboard/ReplayContext";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { StreamButtons } from "../components/LiveActivity";
import { Button } from "../components/ui";
import { addItem, countOf, duplicateItem, emptyBoard, fitBoard, loadBoard, type EagleItem, type LimitOf, removeItem, saveBoard, starterBoard, titleOf, withLayout, type EagleBoard } from "../lib/eagle";
import { fmtExpiry } from "../lib/format";
import { useExpiries } from "../lib/hooks";

const COLS = 12;
const ROW_HEIGHT = 36;
const NARROW = 820; // below this width the boxes stack in one full-width column (no dragging)
type Mode = "weekly" | "monthly" | "manual";
const RANGES: Range[] = [5, 10, 20, "all"];

const ROW_UNIT = ROW_HEIGHT + 12; // a grid row and the gap under it

/**
 * How tall each box may be. A whole tool is exactly as tall as its content (measured): any more and there would be empty space under its charts. A chart widget fills its box, so
 * it may grow into a hole, but not into a long thin strip: comfortably up to 0.8 times its width, and past that (to 1.4 times) only where a hole is left that nothing else can fill.
 */
function limitFor(items: readonly EagleItem[], nat: Readonly<Record<string, number>>, width: number, pinned: ReadonlySet<string> = new Set()): LimitOf {
  return (b) => {
    if (pinned.has(b.i)) return { soft: b.h, hard: b.h }; // the person sized this box: it stays as they made it
    const def = CATALOG_BY_ID.get(items.find((x) => x.key === b.i)?.cat ?? "");
    if (!def) return undefined;
    if (def.kind === "page") { const n = nat[b.i]; return n ? { soft: n, hard: n } : undefined; }
    const wpx = ((width > 0 ? width : 1200) / COLS) * b.w;
    return { soft: Math.ceil((0.8 * wpx + 12) / ROW_UNIT), hard: Math.ceil((1.4 * wpx + 12) / ROW_UNIT) };
  };
}
const fitWith = (b: EagleBoard, nat: Readonly<Record<string, number>> = {}, width = 0, pinned?: ReadonlySet<string>): EagleBoard => fitBoard(b, limitFor(b.items, nat, width, pinned));

const starter = () => fitWith(starterBoard(STARTER, sizeOf));
const AUTOFIT_KEY = "nse.eagles.autofit.v1";
const CHARTS_KEY = "nse.eagles.charts.v1";
const CHROME_PX = 33 + 16; // a box's title bar (with its border) and the padding round its body

/** A whole tool's own height in grid rows: what its content needs, measured, so the box can be sized to it (no empty space under its charts). */
function useNaturalRows(ref: React.RefObject<HTMLElement | null>, report: ((rows: number) => void) | undefined) {
  const cb = useRef(report);
  cb.current = report;
  const on = report !== undefined;
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => { const h = el.offsetHeight; if (h > 0) cb.current?.(Math.ceil((h + CHROME_PX + 12) / ROW_UNIT)); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [on, ref]);
}
const loadCharts = (): boolean => { try { return localStorage.getItem(CHARTS_KEY) !== "off"; } catch { return true; } };

/** True when a box that is expected to have no chart really shows none (after its data had time to arrive): then it says so instead of staying blank. */
function useNoChart(ref: React.RefObject<HTMLElement | null>, expect: boolean): boolean {
  const [none, setNone] = useState(false);
  useEffect(() => {
    if (!expect) { setNone(false); return; }
    const t = setTimeout(() => setNone(!ref.current?.querySelector(".echart-box")), 2500);
    return () => clearTimeout(t);
  }, [expect, ref]);
  return none;
}
const loadAuto = (): boolean => { try { return localStorage.getItem(AUTOFIT_KEY) !== "off"; } catch { return true; } };

/** The widget, drawn inside its own error boundary so that one that fails cannot take the board down. */
const Content = ({ def }: { def: EagleDef }) => <>{def.render()}</>;

/** One box of the board: a title bar to drag it by, copy and remove buttons, and the widget, which fits the box (or scrolls inside it for a whole tool). */
function Frame({ board, itemKey, def, onRemove, onCopy, height, chartsOnly, onNat }: { board: EagleBoard; itemKey: string; def: EagleDef; onRemove: () => void; onCopy: () => void; height?: number; chartsOnly?: boolean; onNat?: (key: string, rows: number) => void }) {
  const title = titleOf(board, itemKey, def.title);
  const bodyRef = useRef<HTMLDivElement>(null);
  const noChart = useNoChart(bodyRef, chartsOnly === true && !def.charts);
  const innerRef = useRef<HTMLDivElement>(null);
  useNaturalRows(innerRef, def.kind === "page" ? (rows) => onNat?.(itemKey, rows) : undefined);
  return (
    <section aria-label={title} data-testid={`eagle-box-${itemKey}`} style={height ? { height } : undefined}
      className="flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <header className="eagle-keep widget-drag flex min-h-8 shrink-0 cursor-grab items-center justify-between gap-2 border-b border-rule px-2.5 active:cursor-grabbing">
        <h2 className="min-w-0 truncate text-xs font-semibold text-paper">{title}</h2>
        <div className="flex shrink-0 items-center">
          <button type="button" aria-label={`Add another ${def.title}`} title="Add another copy of this widget" onMouseDown={(e) => e.stopPropagation()} onClick={onCopy}
            className="widget-nodrag inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-slate-2 hover:text-paper">⧉</button>
          <button type="button" aria-label={`Remove ${title}`} title="Remove from the board" onMouseDown={(e) => e.stopPropagation()} onClick={onRemove}
            className="widget-nodrag inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-slate-2 hover:text-paper">×</button>
        </div>
      </header>
      <div ref={bodyRef} className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2 ${def.kind === "page" ? "overflow-x-auto" : ""}`} data-testid={`eagle-body-${itemKey}`}>
        <div ref={innerRef} className={def.kind === "page" ? undefined : "h-full"}>
        {noChart && <p className="eagle-keep rounded-sm border border-rule bg-slate-2 p-2 text-xs text-muted" role="status" data-testid={`eagle-nochart-${itemKey}`}>This tool has no chart. Turn off “Charts only” at the top to see it, or remove the box.</p>}
        <ErrorBoundary resetKey={itemKey}><Content def={def} /></ErrorBoundary>
        </div>
      </div>
    </section>
  );
}

/** The picker: every widget, grouped, searchable. A widget can be added as often as wanted; the number on the board is shown. */
function Picker({ board, onAdd, onClose, chartsOnly }: { board: EagleBoard; onAdd: (id: string) => void; onClose: () => void; chartsOnly: boolean }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => catalogGroups(q, chartsOnly), [q, chartsOnly]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector("input")?.focus(); }, []);
  return (
    <div ref={ref} role="dialog" aria-label="Add widgets" data-testid="eagle-picker"
      className="absolute left-0 top-11 z-30 flex max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] flex-col rounded-md border border-rule bg-slate shadow-lg">
      <div className="flex items-center gap-2 border-b border-rule p-2">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search widgets and tools…" aria-label="Search widgets"
          className="min-h-9 min-w-0 flex-1 rounded-sm border border-rule bg-slate-2 px-2 text-sm text-paper" />
        <Button onClick={onClose}>Done</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {chartsOnly && <p className="px-1 pb-2 text-[11px] text-muted" data-testid="eagle-picker-note">Charts only is on: tools that are only a table or text are not listed.</p>}
        {groups.length === 0 && <p className="px-2 py-4 text-sm text-muted" role="status">Nothing matches “{q}”.</p>}
        {groups.map((g) => (
          <section key={g.group} aria-label={g.group} className="mb-3">
            <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.group}</h3>
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {g.defs.map((d) => {
                const n = countOf(board, d.id);
                return (
                  <li key={d.id}>
                    <button type="button" onClick={() => onAdd(d.id)} title={d.blurb} data-testid={`eagle-add-${d.id}`}
                      className="flex min-h-9 w-full items-center justify-between gap-2 rounded-sm border border-rule bg-slate-2 px-2 text-left text-xs text-paper hover:border-brass">
                      <span className="min-w-0 truncate">{d.title}</span>
                      <span className="shrink-0 text-muted" aria-label={n > 0 ? `on the board ${n} time${n === 1 ? "" : "s"}; add another` : "add"}>{n > 0 ? <span className="mr-1 rounded-full bg-brass/20 px-1.5 text-paper" data-testid={`eagle-n-${d.id}`}>×{n}</span> : null}＋</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Board() {
  const { width, containerRef, mounted } = useContainerWidth();
  const [board, setBoard] = useState<EagleBoard>(() => { const saved = loadBoard(sizeOf); return saved ? (loadAuto() ? fitWith(saved) : saved) : starter(); });
  const [picking, setPicking] = useState(false);
  const [auto, setAuto] = useState(loadAuto);
  const [chartsOnly, setChartsOnly] = useState(loadCharts);
  const [nat, setNat] = useState<Record<string, number>>({});
  const onNat = useCallback((key: string, rows: number) => setNat((n) => (n[key] === rows ? n : { ...n, [key]: rows })), []);
  const toggleCharts = (on: boolean) => { setChartsOnly(on); try { localStorage.setItem(CHARTS_KEY, on ? "on" : "off"); } catch { /* the choice lasts for this visit */ } };
  const natRef = useRef(nat);
  natRef.current = nat;
  const widthRef = useRef(width);
  widthRef.current = width;
  const pinned = useRef(new Set<string>()); // boxes the person has resized by hand: auto-fit leaves their height alone
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    saveBoard(board);
  }, [board]);

  // with auto-fit on, every change of the board (a box added, copied, removed, moved or resized) ends with the boxes fitted: no gaps
  const settle = useCallback((b: EagleBoard) => (auto ? fitWith(b, natRef.current, widthRef.current, pinned.current) : b), [auto]);
  // a tool's measured height or the width of the board changed: fit again
  useEffect(() => { if (auto) setBoard((b) => fitWith(b, natRef.current, widthRef.current, pinned.current)); }, [auto, nat, Math.round(width / 40)]); // eslint-disable-line react-hooks/exhaustive-deps
  const onLayoutChange = useCallback((next: Layout) => setBoard((b) => settle(withLayout(b, next))), [settle]);
  const add = (id: string) => { const s = sizeOf(id); if (s) setBoard((b) => settle(addItem(b, id, s))); };
  const copy = (key: string) => setBoard((b) => { const cat = b.items.find((x) => x.key === key)?.cat; const s = cat ? sizeOf(cat) : undefined; return s ? settle(duplicateItem(b, key, s)) : b; });
  const remove = (key: string) => setBoard((b) => settle(removeItem(b, key)));
  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try { localStorage.setItem(AUTOFIT_KEY, on ? "on" : "off"); } catch { /* the choice lasts for this visit */ }
    if (on) setBoard((b) => fitWith(b, natRef.current, widthRef.current, pinned.current));
  };

  const stacked = mounted && width > 0 && width < NARROW;
  const boxes = board.items.map((it) => ({ it, def: CATALOG_BY_ID.get(it.cat)!, box: board.layout.find((l) => l.i === it.key) })).filter((x) => x.def);

  return (
    <>
      <div className="relative flex flex-wrap items-center gap-2">
        <Button onClick={() => setPicking((p) => !p)} title="Add widgets: any tool, as many times as you like">＋ Add widgets</Button>
        <label className="flex items-center gap-1.5 text-sm" title="Show only the charts and their controls: no readings, tables or notes"><input type="checkbox" checked={chartsOnly} onChange={(e) => toggleCharts(e.target.checked)} className="accent-[var(--brass)]" data-testid="eagle-charts-only" /> Charts only</label>
        <label className="flex items-center gap-1.5 text-sm" title="Pack the boxes with no gaps and let them grow into free space"><input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} className="accent-[var(--brass)]" data-testid="eagle-autofit" /> Auto-fit</label>
        <Button onClick={() => setBoard(starter())} title="Back to the starting set of widgets">Starter board</Button>
        <Button onClick={() => setBoard(emptyBoard())} disabled={board.items.length === 0} title="Take every widget off the board">Clear board</Button>
        <span className="text-xs text-muted" data-testid="eagle-count">{board.items.length} widget{board.items.length === 1 ? "" : "s"}</span>
        <span className="hidden text-xs text-muted md:inline">Drag a title bar to move · drag a corner to resize · ⧉ adds another copy · remembered in this browser</span>
        {picking && <Picker board={board} onAdd={add} onClose={() => setPicking(false)} chartsOnly={chartsOnly} />}
      </div>
      <div ref={containerRef} data-testid="eagle-board" className={chartsOnly ? "eagle-co" : undefined}>
        {stacked && boxes.length > 0 && (
          <div className="flex flex-col gap-3" data-testid="eagle-stacked">
            {boxes.map(({ it, def, box }) => (
              <div key={it.key}><Frame board={board} itemKey={it.key} def={def} chartsOnly={chartsOnly} onNat={onNat} onRemove={() => remove(it.key)} onCopy={() => copy(it.key)} height={Math.max(def.kind === "page" ? 420 : 280, (box?.h ?? def.h) * (ROW_HEIGHT + 12) - 12)} /></div>
            ))}
          </div>
        )}
        {mounted && !stacked && boxes.length > 0 && width > 0 && (
          <GridLayout width={width} layout={board.layout} gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ handle: ".widget-drag", cancel: ".widget-nodrag" }} compactor={verticalCompactor} onLayoutChange={onLayoutChange} onResizeStop={(_l, _old, item) => { if (item) pinned.current.add(item.i); }}>
            {boxes.map(({ it, def }) => (
              <div key={it.key}><Frame board={board} itemKey={it.key} def={def} chartsOnly={chartsOnly} onNat={onNat} onRemove={() => remove(it.key)} onCopy={() => copy(it.key)} /></div>
            ))}
          </GridLayout>
        )}
        {board.items.length === 0 && (
          <p className="py-10 text-center text-sm text-muted" role="status" data-testid="eagle-empty">The board is empty. Use “Add widgets” to put any tool on it, or “Starter board” for a first set.</p>
        )}
      </div>
    </>
  );
}

/** A board of small, movable, resizable boxes holding any of the app's tools, as many of each as wanted. */
export function EaglesView() {
  const exp = useExpiries().data;
  const [mode, setMode] = useState<Mode>("weekly");
  const [manual, setManual] = useState("");
  const [range, setRange] = useState<Range>(10);
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  const expiry = mode === "weekly" ? exp?.weekly ?? null : mode === "monthly" ? exp?.monthly ?? null : manual || exp?.available[0] || null;

  const modeBtn = (m: Mode, label: string, date?: string | null) => (
    <button type="button" key={m} aria-pressed={mode === m} disabled={m !== "manual" && !date} onClick={() => setMode(m)}
      className={`min-h-9 rounded-sm border px-3 text-sm disabled:opacity-40 ${mode === m ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>
      {label}{date ? <span className="ml-1.5 text-xs text-muted">{fmtExpiry(date)}</span> : null}
    </button>
  );

  return (
    <ReplayProvider>
      <DashProvider expiry={expiry} range={range} showCalls={showCalls} showPuts={showPuts}>
        <div className="mx-auto flex max-w-[1900px] flex-col gap-3" data-testid="eagles-view">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Eagles view</h1>
              <p className="text-sm text-muted">Every tool as a small box on one board. Add the ones you want, as many times as you like, move and resize them, take off what you do not need.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2"><ChartInfoToggle /><StreamButtons /></div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2" data-testid="eagle-controls">
            <span className="text-sm font-semibold">NIFTY</span>
            <div role="group" aria-label="Expiry" className="flex flex-wrap items-center gap-2">
              {modeBtn("weekly", "Weekly", exp?.weekly)}
              {modeBtn("monthly", "Monthly", exp?.monthly)}
              {modeBtn("manual", "Other")}
              {mode === "manual" && (
                <select aria-label="Choose expiry" value={manual || exp?.available[0] || ""} onChange={(e) => setManual(e.target.value)} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm">
                  {exp?.available.map((x) => <option key={x} value={x}>{fmtExpiry(x)}</option>)}
                </select>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              Strikes around ATM
              <select aria-label="Strike range" value={String(range)} onChange={(e) => setRange(e.target.value === "all" ? "all" : Number(e.target.value))} className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
                {RANGES.map((n) => <option key={String(n)} value={String(n)}>{n === "all" ? "All" : `±${n}`}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)} className="accent-[var(--brass)]" /> Calls</label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)} className="accent-[var(--brass)]" /> Puts</label>
            <span className="text-xs text-muted">The expiry and strikes apply to every box that uses the option chain.</span>
          </div>
          <Board />
        </div>
      </DashProvider>
    </ReplayProvider>
  );
}

export default EaglesView;
