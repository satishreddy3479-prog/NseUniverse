import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, verticalCompactor, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { DashProvider, useDash, type Range } from "../components/dashboard/DashContext";
import { DEFAULT_ACTIVE, NEW_DEFAULT_WIDGETS, WIDGETS, type WidgetDef } from "../components/dashboard/widgets";
import { CommandCenter } from "../components/CommandCenter";
import { StreamButtons } from "../components/LiveActivity";
import { Button } from "../components/ui";
import { fmtExpiry, fmtPct, fmtPrice, fmtSigned } from "../lib/format";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST } from "../lib/format";
import { useExpiries } from "../lib/hooks";
import { useLiveSpot } from "../lib/useLive";

const STORAGE_KEY = "nse.analysis.layout.v1";
const SEEN_KEY = "nse.analysis.seen.v1";
const COLS = 12;
const NARROW = 820; // below this width the widgets stack in one full-width column (no dragging)
const ROW_HEIGHT = 36;
type Mode = "weekly" | "monthly" | "manual";
const RANGES: Range[] = [5, 10, 20, "all"];

export interface SavedLayout { active: string[]; layout: LayoutItem[] }

export function defaultLayout(active: string[]): LayoutItem[] {
  return WIDGETS.filter((w) => active.includes(w.id)).map((w) => ({
    i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: w.minW, minH: w.minH,
  }));
}

/** Widgets added after a layout was saved are offered once: added to the saved layout the first time, then left to the user. */
function withNewDefaults(base: SavedLayout): SavedLayout {
  try {
    const seen = new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
    const fresh = NEW_DEFAULT_WIDGETS.filter((id) => !seen.has(id));
    if (!fresh.length) return base;
    const active = [...base.active], layout = [...base.layout];
    for (const id of fresh) if (!active.includes(id)) { active.push(id); layout.push({ ...defaultLayout([id])[0]!, y: 1000 }); }
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...fresh]));
    return { active, layout };
  } catch { return base; }
}

export function loadLayout(): SavedLayout {
  const fallback = { active: DEFAULT_ACTIVE, layout: defaultLayout(DEFAULT_ACTIVE) };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return withNewDefaults(fallback);
    const v = JSON.parse(raw) as SavedLayout;
    const known = new Set(WIDGETS.map((w) => w.id));
    const active = (v.active ?? []).filter((id) => known.has(id));
    if (!active.length && (v.active ?? []).length) return fallback;
    const layout = (v.layout ?? []).filter((l) => active.includes(l.i));
    // any active widget without a saved box gets its default one
    for (const id of active) if (!layout.some((l) => l.i === id)) layout.push(defaultLayout([id])[0]!);
    return withNewDefaults({ active, layout });
  } catch {
    return fallback;
  }
}

function saveLayout(s: SavedLayout) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable: layout lasts for this visit only */ }
}

function Frame({ def, onClose }: { def: WidgetDef; onClose: () => void }) {
  return (
    <section aria-label={def.title} className="flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-slate">
      <header className="widget-drag flex min-h-9 cursor-grab items-center justify-between gap-2 border-b border-rule px-3 active:cursor-grabbing">
        <h2 className="truncate text-sm font-semibold text-paper">{def.title}</h2>
        <button type="button" aria-label={`Remove ${def.title}`} title="Remove widget"
          onMouseDown={(e) => e.stopPropagation()} onClick={onClose}
          className="widget-nodrag -mr-1 inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-slate-2 hover:text-paper">×</button>
      </header>
      <div className="min-h-0 flex-1 p-2">{def.render()}</div>
    </section>
  );
}

function SpotBox() {
  const d = useDash();
  const ls = useLiveSpot();
  const live = ls.live;
  const spot = live ? ls.ltp : (d.snapshot?.underlying_ltp ?? null);
  const prev = live ? ls.prevClose : (d.snapshot?.underlying_prev_close ?? null);
  const chg = spot != null && prev != null && prev > 0 ? spot - prev : null;
  return (
    <div className="flex items-baseline gap-2 rounded-sm border border-rule bg-slate-2 px-3 py-1.5" aria-label="Spot price">
      <span className="text-xs text-muted" title={live ? "From the live stream" : "From the latest stored snapshot"}>Spot {live ? "(live)" : d.snapshot ? `(snapshot ${fmtTimeIST(d.snapshot.retrieved_at)})` : "(snapshot)"}</span>
      <span className="num text-base font-semibold text-paper">{fmtPrice(spot)}</span>
      {chg != null && (
        <span className={`num text-xs font-medium ${chg >= 0 ? "text-up" : "text-down"}`}>
          {fmtSigned(Math.round(chg * 100) / 100)} ({fmtPct((chg / (prev as number)) * 100)})
        </span>
      )}
    </div>
  );
}

/** What fills the time-series widgets, in one honest line. Hidden when the backend predates sampling. */
export function SamplerNote() {
  const q = useQuery({ queryKey: ["sampler"], queryFn: api.sampler, refetchInterval: 15_000, retry: false });
  const s = q.data;
  if (!s) return null;
  const every = `every ${s.interval_seconds} s`;
  let text: string;
  let tone = "text-muted";
  if (!s.enabled) text = "Automatic sampling is turned off (SAMPLER_ENABLED=false). Use “Refresh snapshot” to store points.";
  else if (s.state === "error") {
    tone = "text-warn";
    text = `Sampling ${every} during market hours, but the last attempt failed: ${s.last_error ?? "unknown error"}. Retrying.`;
  } else if (!s.in_session)
    text = `Sampling ${every} during ${s.session}. Waiting: ${s.reason}.`;
  else text = `Sampling ${every} now (${s.session}).`;
  return (
    <p className={`text-xs ${tone}`} data-testid="sampler-note">
      {text}
      {s.last_success_at && <> Last stored {fmtTimeIST(s.last_success_at)} · {s.samples_this_run} this run.</>}
      {s.skipped_unchanged > 0 && <> {s.skipped_unchanged} unchanged chain{s.skipped_unchanged === 1 ? "" : "s"} not re-stored.</>}
      {s.free_disk_gb != null && s.free_disk_gb < 5 && <span className="text-warn"> Disk: {s.free_disk_gb.toFixed(1)} GB free.</span>}
    </p>
  );
}

function Board() {
  const d = useDash();
  const { width, containerRef, mounted } = useContainerWidth();
  const [saved, setSaved] = useState<SavedLayout>(loadLayout);
  const [menu, setMenu] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    saveLayout(saved);
  }, [saved]);

  const onLayoutChange = useCallback((next: Layout) => {
    setSaved((s) => {
      const layout = next.map((l) => ({ ...l }));
      return JSON.stringify(layout) === JSON.stringify(s.layout) ? s : { ...s, layout };
    });
  }, []);

  const close = (id: string) =>
    setSaved((s) => ({ active: s.active.filter((x) => x !== id), layout: s.layout.filter((l) => l.i !== id) }));
  const add = (id: string) => {
    setSaved((s) => {
      if (s.active.includes(id)) return s;
      const def = WIDGETS.find((w) => w.id === id)!;
      const bottom = s.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
      return { active: [...s.active, id], layout: [...s.layout, { i: id, x: 0, y: bottom, w: def.w, h: def.h, minW: def.minW, minH: def.minH }] };
    });
    setMenu(false);
  };
  const reset = () => setSaved({ active: DEFAULT_ACTIVE, layout: defaultLayout(DEFAULT_ACTIVE) });

  const active = useMemo(() => WIDGETS.filter((w) => saved.active.includes(w.id)), [saved.active]);
  const hidden = WIDGETS.filter((w) => !saved.active.includes(w.id));

  return (
    <>
      <div className="relative flex flex-wrap items-center gap-2">
        <Button onClick={() => setMenu((m) => !m)} title="Add a widget to the dashboard">＋ Add widget</Button>
        <Button onClick={reset} title="Restore the default widgets and positions">Reset layout</Button>
        {menu && (
          <ul role="menu" aria-label="Add widget"
            className="absolute left-0 top-11 z-20 min-w-64 rounded-sm border border-rule bg-slate p-1 shadow-lg">
            {hidden.length === 0 && <li className="px-3 py-2 text-sm text-muted">All widgets are on the dashboard.</li>}
            {hidden.map((w) => (
              <li key={w.id} role="none">
                <button type="button" role="menuitem" onClick={() => add(w.id)}
                  className="block min-h-9 w-full rounded-sm px-3 text-left text-sm text-paper hover:bg-slate-2">{w.title}</button>
              </li>
            ))}
          </ul>
        )}
        <span className="hidden text-xs text-muted md:inline">Drag a title bar to move · drag a corner to resize · layout is remembered in this browser</span>
      </div>

      <div ref={containerRef} data-testid="board">
        {mounted && active.length > 0 && width > 0 && width < NARROW && (
          <div className="flex flex-col gap-3" data-testid="board-stacked">
            {active.map((w) => (
              <div key={w.id} style={{ height: Math.max(300, w.h * (ROW_HEIGHT + 12) - 12) }}><Frame def={w} onClose={() => close(w.id)} /></div>
            ))}
          </div>
        )}
        {mounted && active.length > 0 && !(width > 0 && width < NARROW) && (
          <GridLayout
            width={width}
            layout={saved.layout}
            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ handle: ".widget-drag", cancel: ".widget-nodrag" }}
            compactor={verticalCompactor}
            onLayoutChange={onLayoutChange}
          >
            {active.map((w) => (
              <div key={w.id}><Frame def={w} onClose={() => close(w.id)} /></div>
            ))}
          </GridLayout>
        )}
        {active.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">No widgets on the dashboard. Use “Add widget” or “Reset layout”.</p>
        )}
      </div>
      {d.fetchError && <p role="alert" className="text-sm text-down">{d.fetchError}</p>}
    </>
  );
}

export function Analysis() {
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
    <DashProvider expiry={expiry} range={range} showCalls={showCalls} showPuts={showPuts}>
      <div className="mx-auto flex max-w-[1700px] flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Intraday analysis</h1>
            <p className="text-sm text-muted">
              NIFTY 50 session view from the Kotak Neo samples stored every minute in market hours. Sentiment is rules-based and provisional; widgets update live when the stream runs.
            </p>
          </div>
          <StreamButtons />
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[var(--radius-panel)] border border-rule bg-slate px-3 py-2">
          <span className="text-sm font-semibold">NIFTY</span>
          <div role="group" aria-label="Expiry" className="flex flex-wrap items-center gap-2">
            {modeBtn("weekly", "Weekly", exp?.weekly)}
            {modeBtn("monthly", "Monthly", exp?.monthly)}
            {modeBtn("manual", "Other")}
            {mode === "manual" && (
              <select aria-label="Choose expiry" value={manual || exp?.available[0] || ""} onChange={(e) => setManual(e.target.value)}
                className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-sm">
                {exp?.available.map((x) => <option key={x} value={x}>{fmtExpiry(x)}</option>)}
              </select>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">
            Strikes around ATM
            <select aria-label="Strike range" value={String(range)} onChange={(e) => setRange(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-paper">
              {RANGES.map((n) => <option key={String(n)} value={String(n)}>{n === "all" ? "All" : `±${n}`}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)} className="accent-[var(--brass)]" /> Calls</label>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)} className="accent-[var(--brass)]" /> Puts</label>
          <div className="ml-auto"><SpotBox /></div>
        </div>

        <SamplerNote />
        <CommandCenter expiry={expiry} />
        <div id="widgets" className="scroll-mt-4 flex flex-col gap-3">
          <h2 className="text-base font-semibold text-paper">Option-chain widgets</h2>
          <Board />
        </div>
      </div>
    </DashProvider>
  );
}

export default Analysis;
