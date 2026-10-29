import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { EChart, useChartColors } from "../EChart";
import { ChainTable } from "../ChainTable";
import { Button, EmptyState, SourceTag } from "../ui";
import { useDash } from "./DashContext";
import { FullChart } from "./FullChart";
import { atmStraddle, compactIN, computeTotals, maxPain, OI_MODES, OI_WINDOWS, oiWindowStats, pcr, rangeObservations, TS_RANGES, windowEndIso, windowStartIso, type OiMode } from "../../lib/analytics";
import {
  decayOption, oiChangeBarOption, oiHeatmapOption, premiumOption, spotOption, straddleOption, strikeBarOption,
  oiExplorerOption, totalsBarOption, type StrikeMetric } from "../../lib/chartOptions";
import { ageSeconds, fmtDateTimeIST, fmtExpiry, fmtTimeIST, fmtInt, fmtPct, fmtPrice, fmtSigned } from "../../lib/format";
import { useLiveSpot } from "../../lib/useLive";
import type { BaselineKind, Observation, OiChange, OptionChainRow } from "../../lib/types";

/** Age in seconds of the newest stored sample, re-evaluated every 15 s so the label cannot go stale. */
function useLastSample(): { at: string | null; age: number | null } {
  const d = useDash();
  const obs = d.history.data?.observations;
  const at = obs && obs.length ? obs[obs.length - 1]!.retrieved_at : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return { at, age: ageSeconds(at, now) };
}

/** Time-series widgets are built from stored samples; say how fresh the newest one is. */
function SampleTag() {
  const { at } = useLastSample();
  return at ? <span title="Charts plot the option-chain samples stored every minute in market hours (not individual ticks).">last sample {fmtTimeIST(at)}</span> : null;
}

/** Source line printed under every widget: where the numbers come from and how fresh they are. */
function Meta({ kind, children }: { kind: "chain" | "history"; children?: ReactNode }) {
  const d = useDash();
  const snap = d.snapshot;
  if (!snap) return null;
  const live = kind === "chain" && d.liveMode === "fresh";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
      {kind === "history" ? <SampleTag /> : <SourceTag source={live ? "live" : "snapshot"} />}
      <span>{fmtExpiry(d.expiry)}</span>
      <span>{d.universeLabel}</span>
      {kind === "chain" && !live && <span>snapshot {fmtDateTimeIST(snap.retrieved_at)}</span>}
      {kind === "chain" && d.liveMode === "stale" && <span className="text-warn">stream stale</span>}
      {children}
    </p>
  );
}

function Body({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {footer}
    </div>
  );
}

function NoChain() {
  const d = useDash();
  if (d.chain.isPending && d.expiry) return <p className="p-3 text-sm text-muted">Loading snapshot…</p>;
  if (d.noSnapshot)
    return (
      <EmptyState title="No snapshot stored for this expiry"
        action={<Button variant="primary" disabled={d.fetching} onClick={d.fetchChain}>{d.fetching ? "Fetching…" : "Fetch snapshot"}</Button>}>
        Fetch it once from Kotak Neo; every widget then builds from it.
      </EmptyState>
    );
  if (d.chain.error) return <EmptyState title="Could not load the chain">{String((d.chain.error as Error).message)}</EmptyState>;
  if (!d.expiry) return <EmptyState title="No expiry selected" />;
  return null;
}

function ChainGuard({ children }: { children: ReactNode }) {
  const d = useDash();
  return d.snapshot ? <>{children}</> : <NoChain />;
}

// ---------- strike-wise bar widgets ----------

function StrikeBars({ metric, label }: { metric: StrikeMetric; label: string }) {
  const d = useDash();
  const colors = useChartColors();
  const opt = useMemo(
    () => strikeBarOption({
      rows: d.view, metric, atmStrike: d.atmStrike, selectedStrike: d.selected,
      showCalls: d.showCalls, showPuts: d.showPuts, colors,
    }),
    [d.view, metric, d.atmStrike, d.selected, d.showCalls, d.showPuts, colors],
  );
  const baseline = metric === "oiChange" ? <span>OI change = current OI − previous-day OI (computed here)</span> : null;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain">{baseline}</Meta>}>
        <div className="flex h-full flex-col">
          <div className="mb-1 flex justify-end">
            <button type="button" onClick={() => setOpen(true)} aria-label={`Open ${label} by strike full size`} title="Open this chart full size"
              className="widget-nodrag inline-flex min-h-6 items-center rounded-sm border border-rule bg-slate-2 px-2 text-xs text-muted hover:border-brass hover:text-paper">⤢ Full</button>
          </div>
          <div className="min-h-0 flex-1">
            <EChart option={opt} ariaLabel={`${label} by strike`}
              onClick={(p) => { const s = Number(p.name); if (Number.isFinite(s)) d.select(s); }} />
          </div>
        </div>
      </Body>
      {open && (
        <FullChart title={`${label} by strike`} onClose={close}
          footer={<>{fmtExpiry(d.expiry)} · {d.universeLabel}. Drag the bar below the chart or scroll to zoom; hover for exact values; click a bar to select its strike.</>}>
          <EChart option={opt} ariaLabel={`${label} by strike (full size)`}
            onClick={(p) => { const s = Number(p.name); if (Number.isFinite(s)) d.select(s); }} />
        </FullChart>
      )}
    </ChainGuard>
  );
}

function TotalsBars({ metric, label }: { metric: StrikeMetric; label: string }) {
  const d = useDash();
  const colors = useChartColors();
  const opt = useMemo(
    () => totalsBarOption({ totals: d.totals, metric, showCalls: d.showCalls, showPuts: d.showPuts, colors }),
    [d.totals, metric, d.showCalls, d.showPuts, colors],
  );
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain" />}>
        <EChart option={opt} ariaLabel={label} />
      </Body>
    </ChainGuard>
  );
}

export const OiWidget = () => <OiExplorerWidget />;
export const OiTotalWidget = () => <TotalsBars metric="oi" label="Total open interest, calls vs puts" />;
export const OiChangeWidget = () => <StrikeBars metric="oiChange" label="OI change" />;
export const OiChangeTotalWidget = () => <TotalsBars metric="oiChange" label="Total OI change, calls vs puts" />;
export const VolumeWidget = () => <StrikeBars metric="volume" label="Volume" />;

// ---------- chain table ----------

export function ChainWidget() {
  const d = useDash();
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain">{<span>click a row to select a strike</span>}</Meta>}>
        <div className="h-full">
          <ChainTable rows={d.view} allRows={d.rows} showCalls={d.showCalls} showPuts={d.showPuts}
            liveMode={d.liveMode} atmStrike={d.atmStrike} atmLive={d.atmLive}
            selectedStrike={d.selected} onSelectStrike={d.select} maxHeight="h-full" />
        </div>
      </Body>
    </ChainGuard>
  );
}

// ---------- time-series widgets (stored snapshot observations) ----------

function RangeChips({ small = false }: { small?: boolean }) {
  const d = useDash();
  return (
    <div role="group" aria-label="Time range" className="flex items-center gap-1">
      {TS_RANGES.map((r) => (
        <button key={r.id} type="button" title={r.title} aria-pressed={d.tsRange === r.id} onClick={() => d.setTsRange(r.id)}
          className={`widget-nodrag rounded-sm border px-2 text-xs ${small ? "min-h-6" : "min-h-9 text-sm"} ${d.tsRange === r.id ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function TimeSeries({ build, label, note }: {
  build: (obs: Observation[], c: ReturnType<typeof useChartColors>) => ReturnType<typeof premiumOption>;
  label: string;
  /** Extra line about how the series is built (e.g. its baseline). */
  note?: string;
}) {
  const d = useDash();
  const colors = useChartColors();
  const [open, setOpen] = useState(false);
  const all = d.history.data?.observations ?? [];
  const { rows: obs, note: rangeNote } = useMemo(() => rangeObservations(all, d.tsRange), [all, d.tsRange]);
  const opt = useMemo(() => build(obs, colors), [build, obs, colors]);
  const distinct = new Set(obs.map((o) => `${o.underlying_ltp}|${o.total_ce_oi}|${o.total_pe_oi}|${o.total_ce_premium}|${o.total_pe_premium}`)).size;
  const rangeLabel = TS_RANGES.find((r) => r.id === d.tsRange)!.label;
  const close = useCallback(() => setOpen(false), []);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>{obs.length} sample{obs.length === 1 ? "" : "s"} · {rangeLabel}{all.length !== obs.length ? ` of ${all.length} stored` : ""}</span></Meta>}>
        {d.history.isPending ? (
          <p className="p-3 text-sm text-muted">Loading stored snapshots…</p>
        ) : all.length < 2 ? (
          <EmptyState title="Not enough stored snapshots to draw a line">
            {all.length} snapshot stored for this expiry and strike range. A line needs at least two. Each
            “Refresh snapshot” stores one more; during market hours the sampler stores one a minute.
          </EmptyState>
        ) : (
          <div className="flex h-full flex-col">
            <div className="mb-1 flex items-center justify-between gap-2">
              <RangeChips small />
              <button type="button" onClick={() => setOpen(true)} aria-label={`Open ${label} full size`} title="Open this chart full size (or click the line)"
                className="widget-nodrag inline-flex min-h-6 items-center rounded-sm border border-rule bg-slate-2 px-2 text-xs text-muted hover:border-brass hover:text-paper">⤢ Full</button>
            </div>
            {(rangeNote || obs.length < 2) && (
              <p className="mb-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                {obs.length < 2 ? `Fewer than two samples in “${rangeLabel}”: pick a longer range.` : rangeNote}
              </p>
            )}
            {obs.length >= 2 && distinct < 2 && (
              <p className="mb-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                All {obs.length} samples in this range carry identical values (market closed or nothing changed), so the line is flat.
              </p>
            )}
            <div className="min-h-0 flex-1"><EChart option={opt} ariaLabel={label} onClick={() => setOpen(true)} /></div>
          </div>
        )}
      </Body>
      {open && (
        <FullChart title={label} onClose={close} toolbar={<RangeChips />}
          footer={<>{obs.length} sample{obs.length === 1 ? "" : "s"} · {rangeLabel}{all.length !== obs.length ? ` of ${all.length} stored` : ""}. Drag the bar below the chart or scroll to zoom; hover for exact values.{note ? ` ${note}` : ""}</>}>
          <EChart option={opt} ariaLabel={`${label} (full size)`} />
        </FullChart>
      )}
    </ChainGuard>
  );
}

export function PremiumWidget() {
  const d = useDash();
  const build = useMemo(() => (o: Observation[], c: ReturnType<typeof useChartColors>) => premiumOption(o, c, d.showCalls, d.showPuts), [d.showCalls, d.showPuts]);
  return <TimeSeries build={build} label="Total premium over stored snapshots" />;
}
export function DecayWidget() {
  const d = useDash();
  const build = useMemo(() => (o: Observation[], c: ReturnType<typeof useChartColors>) => decayOption(o, c, d.showCalls, d.showPuts), [d.showCalls, d.showPuts]);
  return <TimeSeries build={build} label="Premium decay versus first sample in range" note="Baseline = the first sample in the chosen range." />;
}
export const StraddleWidget = () => <TimeSeries build={straddleOption} label="ATM straddle over stored snapshots" />;
export const SpotWidget = () => <TimeSeries build={spotOption} label="NIFTY 50 at each stored snapshot" />;

// ---------- key levels ----------

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0 border-b border-rule/50 py-1.5" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num truncate text-[15px] font-medium ${tone ?? "text-paper"}`}>{value}</dd>
    </div>
  );
}

export function LevelsWidget() {
  const d = useDash();
  const ls = useLiveSpot();
  const liveSpot = ls.live ? ls : null;
  const snap = d.snapshot;
  const spot = liveSpot?.ltp ?? snap?.underlying_ltp ?? null;
  const prev = liveSpot?.prevClose ?? snap?.underlying_prev_close ?? null;
  const chg = spot != null && prev != null && prev > 0 ? spot - prev : null;
  const defs = d.history.data?.definitions ?? {};
  const mp = useMemo(() => maxPain(d.view), [d.view]);
  const straddle = atmStraddle(d.rows, d.atmStrike);
  const oiPcr = pcr(d.totals.peOi, d.totals.ceOi);
  const volPcr = pcr(d.totals.peVolume, d.totals.ceVolume);
  const tone = chg == null || chg === 0 ? undefined : chg > 0 ? "text-up" : "text-down";
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain" />}>
        <dl className="grid h-full grid-cols-2 content-start gap-x-4 overflow-auto sm:grid-cols-3">
          <Stat label="NIFTY 50" value={fmtPrice(spot)} hint={liveSpot ? "Live" : "From the snapshot"} />
          <Stat label="Change vs prev close" tone={tone}
            value={chg == null ? "—" : `${fmtSigned(Math.round(chg * 100) / 100)} (${fmtPct((chg / (prev as number)) * 100)})`} />
          <Stat label="Previous close" value={fmtPrice(prev)} />
          <Stat label="ATM strike" value={fmtInt(d.atmStrike)} hint={d.atmLive ? "Follows the live index" : "Nearest strike to the snapshot spot"} />
          <Stat label="ATM straddle" value={straddle ? fmtPrice(straddle.premium) : "—"} hint={defs.straddle ?? "ATM call LTP + ATM put LTP"}
          />
          <Stat label="Max pain" value={mp ? fmtInt(mp.strike) : "—"}
            hint="Settlement strike where option buyers collectively lose most, from OI of the strikes in view" />
          <Stat label="Total call OI" value={compactIN(d.totals.ceOi)} hint={`Sum over ${d.universeLabel}`} />
          <Stat label="Total put OI" value={compactIN(d.totals.peOi)} hint={`Sum over ${d.universeLabel}`} />
          <Stat label="PCR (OI)" value={oiPcr == null ? "—" : oiPcr.toFixed(2)} hint="Total put OI ÷ total call OI" />
          <Stat label="PCR (volume)" value={volPcr == null ? "—" : volPcr.toFixed(2)} hint="Total put volume ÷ total call volume" />
          <Stat label="Lot size" value={fmtInt(snap?.lot_size ?? null)} hint="OI and volume are in units; divide by lot size for lots" />
          <Stat label="Strikes in view" value={fmtInt(d.view.length)} />
        </dl>
      </Body>
    </ChainGuard>
  );
}

// ---------- strike detail ----------

function QuoteCol({ title, q }: { title: string; q: OptionChainRow["call"] }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-sm font-semibold text-paper">{title}</h3>
      {!q ? <p className="text-sm text-muted">No contract</p> : (
        <dl className="space-y-1 text-sm">
          {([
            ["LTP", fmtPrice(q.ltp)],
            ["OI", fmtInt(q.oi)],
            ["OI change", fmtInt(q.oi_change)],
            ["Volume", fmtInt(q.volume)],
          ] as const).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="num text-paper">{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function DetailWidget() {
  const d = useDash();
  const row = d.selected == null ? undefined : d.rows.find((r) => r.strike === d.selected);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain" />}>
        {!row ? (
          <EmptyState title="No strike selected">Click a bar in a chart or a row in the option chain.</EmptyState>
        ) : (
          <div>
            <p className="mb-2 flex items-center justify-between text-sm">
              <span className="num text-lg font-semibold text-paper">{fmtInt(row.strike)}</span>
              <Button onClick={() => d.select(null)}>Clear</Button>
            </p>
            <div className="grid grid-cols-2 gap-6">
              <QuoteCol title="Call (CE)" q={row.call} />
              <QuoteCol title="Put (PE)" q={row.put} />
            </div>
          </div>
        )}
      </Body>
    </ChainGuard>
  );
}

// ---------- OI intelligence (stored observations, explicit baselines) ----------

const BASELINES: { value: BaselineKind; label: string }[] = [
  { value: "session_open", label: "Session open (first observation today)" },
  { value: "previous", label: "Previous distinct observation" },
  { value: "at", label: "A selected time" },
  { value: "prev_session", label: "Previous session (our stored data)" },
  { value: "broker_prev_day", label: "Broker previous-day OI (unverified)" },
];

/** Percentage-point change; a change that rounds to 0.0 has no sign. */
function fmtPts(v: number): string {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? "0.0 pts" : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)} pts`;
}

function strikesParam(range: number | "all"): string {
  return range === "all" ? "all" : String(range);
}

function istToIso(local: string): string | undefined {
  return local ? `${local}:00+05:30` : undefined; // the picker is in IST
}

function BaselineControls({ kind, onKind, at, onAt, kinds }: {
  kind: BaselineKind; onKind: (k: BaselineKind) => void; at: string; onAt: (v: string) => void;
  kinds?: BaselineKind[];
}) {
  const opts = BASELINES.filter((b) => !kinds || kinds.includes(b.value));
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <label className="flex items-center gap-1.5">
        Baseline
        <select aria-label="OI baseline" value={kind} onChange={(e) => onKind(e.target.value as BaselineKind)}
          className="widget-nodrag min-h-8 rounded-sm border border-rule bg-slate-2 px-1.5 text-paper">
          {opts.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
      </label>
      {kind === "at" && (
        <label className="flex items-center gap-1.5">
          Time (IST)
          <input type="datetime-local" aria-label="Baseline time (IST)" value={at} onChange={(e) => onAt(e.target.value)}
            className="widget-nodrag min-h-8 rounded-sm border border-rule bg-slate-2 px-1.5 text-paper" />
        </label>
      )}
    </div>
  );
}

function useOiChange(kind: BaselineKind, at: string) {
  const d = useDash();
  const q = useQuery({
    queryKey: ["oi", d.expiry, kind, at, d.range],
    queryFn: () => api.oiChange(d.expiry!, kind, strikesParam(d.range), istToIso(at)),
    enabled: !!d.expiry && (kind !== "at" || !!at),
    refetchInterval: 30_000,
    retry: false,
  });
  return q;
}

function BaselineSummary({ res }: { res: OiChange }) {
  const b = res.baseline;
  const sign = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${compactIN(Math.abs(v))}`);
  return (
    <div className="mb-1 space-y-0.5 text-[11px] text-muted" data-testid="oi-summary">
      <p>
        <span className="text-paper">{b.label}</span>
        {b.at ? <> · baseline {fmtDateTimeIST(b.at)} → now {fmtDateTimeIST(res.current_at)}</> : null}
        {res.underlying_change != null && <> · NIFTY {res.underlying_change >= 0 ? "+" : "−"}{fmtPrice(Math.abs(res.underlying_change))} over the interval</>}
      </p>
      <p>Total OI change (units): calls {sign(res.totals.ce_change)} · puts {sign(res.totals.pe_change)}</p>
      {res.warnings.map((w) => <p key={w} className="text-warn">{w}</p>)}
    </div>
  );
}

function OiGuard({ q, children }: { q: ReturnType<typeof useOiChange>; children: (res: OiChange) => ReactNode }) {
  if (q.isPending && q.fetchStatus === "idle") return <p className="p-3 text-sm text-muted">Choose a baseline time.</p>;
  if (q.isPending) return <p className="p-3 text-sm text-muted">Loading observations…</p>;
  if (q.error) return <EmptyState title="Could not load OI observations">{String((q.error as Error).message)}</EmptyState>;
  const res = q.data!;
  if (res.observations_available === 0)
    return (
      <EmptyState title="No observations stored for this expiry yet">
        Observations are recorded each time a chain is fetched (Refresh snapshot, or the market-hours sampler).
      </EmptyState>
    );
  return <>{children(res)}</>;
}

export function OiIntradayWidget() {
  const d = useDash();
  const colors = useChartColors();
  const [kind, setKind] = useState<BaselineKind>("session_open");
  const [at, setAt] = useState("");
  const q = useOiChange(kind, at);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>click a bar to select a strike</span></Meta>}>
        <div className="flex h-full flex-col">
          <BaselineControls kind={kind} onKind={setKind} at={at} onAt={setAt} />
          <OiGuard q={q}>
            {(res) => (
              <>
                <BaselineSummary res={res} />
                {res.rows.every((r) => r.change == null) ? (
                  <EmptyState title="No comparable baseline">{res.baseline.note || "Insufficient data for this baseline."}</EmptyState>
                ) : (
                  <div className="min-h-0 flex-1">
                    <OiBars res={res} colors={colors} calls={d.showCalls} puts={d.showPuts} selected={d.selected} onSelect={d.select} />
                  </div>
                )}
              </>
            )}
          </OiGuard>
        </div>
      </Body>
    </ChainGuard>
  );
}

function OiBars({ res, colors, calls, puts, selected, onSelect }: {
  res: OiChange; colors: ReturnType<typeof useChartColors>; calls: boolean; puts: boolean;
  selected: number | null; onSelect: (k: number) => void;
}) {
  const opt = useMemo(() => oiChangeBarOption(res, calls, puts, selected, colors), [res, calls, puts, selected, colors]);
  return <EChart option={opt} ariaLabel="OI change by strike against the chosen baseline"
    onClick={(p) => { const s = Number(p.name); if (Number.isFinite(s)) onSelect(s); }} />;
}

export function OiHeatmapWidget() {
  const d = useDash();
  const colors = useChartColors();
  const [kind, setKind] = useState<BaselineKind>("session_open");
  const [side, setSide] = useState<"CE" | "PE">("CE");
  const q = useQuery({
    queryKey: ["oi-heatmap", d.expiry, side, kind, d.range],
    queryFn: () => api.oiHeatmap(d.expiry!, side, kind, strikesParam(d.range)),
    enabled: !!d.expiry,
    refetchInterval: 30_000,
    retry: false,
  });
  const h = q.data;
  const opt = useMemo(() => (h ? oiHeatmapOption(h, colors) : {}), [h, colors]);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history">{h && <span>{h.times.length} columns{h.stride > 1 ? ` (every ${h.stride}th)` : ""}</span>}</Meta>}>
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Heatmap side" className="mb-1 flex gap-1">
              {(["CE", "PE"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                  className={`widget-nodrag min-h-8 rounded-sm border px-2.5 text-xs ${side === s ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted"}`}>
                  {s === "CE" ? "Calls" : "Puts"}
                </button>
              ))}
            </div>
            <BaselineControls kind={kind} onKind={setKind} at="" onAt={() => {}} kinds={["session_open", "previous", "prev_session", "broker_prev_day"]} />
          </div>
          {q.isPending ? <p className="p-3 text-sm text-muted">Loading observations…</p>
            : q.error ? <EmptyState title="Could not load the heatmap">{String((q.error as Error).message)}</EmptyState>
            : !h || h.times.length === 0 ? <EmptyState title="No observations stored for this expiry yet" />
            : h.times.length < 2 && kind !== "broker_prev_day" ? (
              <EmptyState title="Only one observation so far">A time grid needs at least two. {h.warnings.join(" ")}</EmptyState>
            ) : (
              <>
                <p className="mb-1 text-[11px] text-muted" data-testid="heatmap-note">
                  {h.baseline.label}{h.baseline.at ? ` (${fmtDateTimeIST(h.baseline.at)})` : ""} · blue = OI above baseline, amber = below · blank = missing ({h.missing_cells} cells)
                  {h.warnings.map((w) => <span key={w} className="ml-2 text-warn">{w}</span>)}
                </p>
                <div className="min-h-0 flex-1"><EChart option={opt} ariaLabel={`OI change heatmap, ${side === "CE" ? "calls" : "puts"}`} /></div>
              </>
            )}
        </div>
      </Body>
    </ChainGuard>
  );
}

export function OiConcentrationWidget() {
  const [kind, setKind] = useState<BaselineKind>("session_open");
  const [at, setAt] = useState("");
  const q = useOiChange(kind, at);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>share of each side's total OI in view; not support or resistance</span></Meta>}>
        <div className="flex h-full flex-col">
          <BaselineControls kind={kind} onKind={setKind} at={at} onAt={setAt} />
          <OiGuard q={q}>
            {(res) => (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-sm" aria-label="OI concentration">
                  <thead className="text-xs text-muted">
                    <tr><th className="text-left font-normal">Side</th><th className="text-right font-normal">Strike</th>
                      <th className="text-right font-normal">OI</th><th className="text-right font-normal">Share</th>
                      <th className="text-right font-normal">Share change</th></tr>
                  </thead>
                  <tbody>
                    {res.concentration.map((c) => (
                      <tr key={`${c.side}${c.strike}`} className="border-t border-rule/50">
                        <td>{c.side === "CE" ? "Call" : "Put"}</td>
                        <td className="num text-right">{fmtInt(c.strike)}</td>
                        <td className="num text-right">{compactIN(c.oi)}</td>
                        <td className="num text-right">{c.share_pct.toFixed(1)}%</td>
                        <td className="num text-right">{c.share_change_pts == null ? "—" : fmtPts(c.share_change_pts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {res.concentration.length === 0 && <EmptyState title="No open interest in view" />}
              </div>
            )}
          </OiGuard>
        </div>
      </Body>
    </ChainGuard>
  );
}

export function PriceOiWidget() {
  const d = useDash();
  const [kind, setKind] = useState<BaselineKind>("session_open");
  const [at, setAt] = useState("");
  const q = useOiChange(kind, at);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>largest OI changes; premium = option LTP between the same two observations</span></Meta>}>
        <div className="flex h-full flex-col">
          <BaselineControls kind={kind} onKind={setKind} at={at} onAt={setAt} />
          <OiGuard q={q}>
            {(res) => {
              const rows = res.rows
                .filter((r) => (r.side === "CE" ? d.showCalls : d.showPuts) && r.change != null)
                .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))
                .slice(0, 14);
              return (
                <div className="min-h-0 flex-1 overflow-auto">
                  <p className="mb-1 text-[11px] text-muted">{res.definitions.relation}</p>
                  <table className="w-full text-sm" aria-label="Price and OI">
                    <thead className="text-xs text-muted">
                      <tr><th className="text-left font-normal">Contract</th><th className="text-right font-normal">OI change</th>
                        <th className="text-right font-normal">Premium change</th><th className="text-left pl-3 font-normal">Observed</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.side}${r.strike}`} className="border-t border-rule/50">
                          <td className="num">{fmtInt(r.strike)} {r.side}</td>
                          <td className="num text-right">{r.change! > 0 ? "+" : r.change! < 0 ? "−" : ""}{compactIN(Math.abs(r.change!))}</td>
                          <td className="num text-right">{r.price_change == null ? "—" : `${r.price_change >= 0 ? "+" : "−"}${fmtPrice(Math.abs(r.price_change))}`}</td>
                          <td className="pl-3 text-muted">{r.relation ?? r.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length === 0 && <EmptyState title="No comparable changes">{res.baseline.note || "Insufficient data for this baseline."}</EmptyState>}
                </div>
              );
            }}
          </OiGuard>
        </div>
      </Body>
    </ChainGuard>
  );
}

// ---------- registry ----------


// ---------- OI by strike over a chosen window (change + total), with totals and PCR ----------

const signedUnits = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${compactIN(Math.abs(v))}`);
const fmt2 = (v: number | null) => (v == null ? "—" : v.toFixed(2));

/** Calls and puts side by side, bars on one scale. Signed values grow up or down from a zero line. */
function PairBars({ title, ce, pe, signed }: { title: string; ce: number | null; pe: number | null; signed: boolean }) {
  const top = Math.max(Math.abs(ce ?? 0), Math.abs(pe ?? 0));
  const H = 88; // px available above (and, for signed values, below) the zero line
  const bar = (v: number | null, cls: string, label: string) => {
    const px = v == null || top <= 0 ? 0 : Math.max(2, (Math.abs(v) / top) * H);
    const up = v == null || v >= 0;
    return (
      <div className="flex flex-1 flex-col items-center">
        <div className="flex w-full items-end justify-center" style={{ height: H + 18 }}>
          {up && <div className="flex flex-col items-center"><span className="num mb-0.5 text-sm text-paper">{v == null ? "—" : signed ? signedUnits(v) : compactIN(v)}</span>{v != null && <div className={`w-14 rounded-t-sm ${cls}`} style={{ height: px }} />}</div>}
        </div>
        {signed && (
          <div className="flex w-full items-start justify-center border-t border-rule" style={{ height: H + 18 }}>
            {!up && <div className="flex flex-col items-center"><div className={`w-14 rounded-b-sm ${cls}`} style={{ height: px }} /><span className="num mt-0.5 text-sm text-paper">{signedUnits(v)}</span></div>}
          </div>
        )}
        <span className="mt-1 text-xs text-muted">{label}</span>
      </div>
    );
  };
  return (
    <figure className="min-w-0 flex-1 basis-60 rounded-sm border border-rule bg-slate-2 p-2" aria-label={title}>
      <figcaption className="mb-1 text-xs font-medium text-paper">{title}</figcaption>
      <div className="flex gap-2">{bar(ce, "bg-up", "CALL")}{bar(pe, "bg-down", "PUT")}</div>
    </figure>
  );
}

/** Full view: change, total and PCR for the chosen time slot, on the same screen as the strike chart. */
function OiCards({ st }: { st: ReturnType<typeof oiWindowStats> }) {
  const tot = st.ceOi != null && st.peOi != null ? st.ceOi + st.peOi : 0;
  const callShare = tot > 0 ? (st.ceOi as number) / tot : null;
  const R = 52, C = 2 * Math.PI * R;
  return (
    <div className="flex flex-wrap gap-2" data-testid="oi-cards">
      <PairBars title="Open Interest Change" ce={st.ceChange} pe={st.peChange} signed />
      <PairBars title="Total Open Interest" ce={st.ceOi} pe={st.peOi} signed={false} />
      <figure className="min-w-0 flex-1 basis-60 rounded-sm border border-rule bg-slate-2 p-2" aria-label="Put/Call Ratio">
        <figcaption className="mb-1 text-xs font-medium text-paper">Put/Call Ratio</figcaption>
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 130 130" className="size-32 shrink-0" role="img" aria-label={callShare == null ? "No OI share" : `Call OI ${(callShare * 100).toFixed(0)}%, put OI ${((1 - callShare) * 100).toFixed(0)}%`}>
            <circle cx="65" cy="65" r={R} fill="none" strokeWidth="16" className="stroke-down" />
            {callShare != null && <circle cx="65" cy="65" r={R} fill="none" strokeWidth="16" className="stroke-up" strokeDasharray={`${callShare * C} ${C}`} transform="rotate(-90 65 65)" />}
            <text x="65" y="60" textAnchor="middle" className="fill-muted" fontSize="11">PCR</text>
            <text x="65" y="80" textAnchor="middle" className="fill-paper" fontSize="22" fontWeight="600">{fmt2(st.pcr)}</text>
          </svg>
          <div className="text-xs text-muted">
            <p>Call OI {callShare == null ? "—" : `${(callShare * 100).toFixed(0)}%`} · Put OI {callShare == null ? "—" : `${((1 - callShare) * 100).toFixed(0)}%`}</p>
            <p className="mt-1">PCR {st.pcrChange == null ? "change —" : `${st.pcrChange >= 0 ? "+" : "−"}${Math.abs(st.pcrChange).toFixed(2)} in slot`}</p>
            <p className="mt-1" title={st.pcrOiChangeNote ?? undefined}>PCR of OI change <span className="num text-paper">{fmt2(st.pcrOiChange)}</span></p>
          </div>
        </div>
      </figure>
    </div>
  );
}

/** Which part of the session the chosen slot covers (read-only; the slot buttons set it). */
function OiRangeTrack({ startIso, endIso, minutes }: { startIso: string | null; endIso: string | null; minutes: number | null }) {
  if (!endIso) return null;
  const istMin = (iso: string) => { const m = Math.floor(new Date(iso).getTime() / 60_000) + 330; return ((m % 1440) + 1440) % 1440; };
  const O = 9 * 60 + 15, L = 375;
  const e = Math.min(1, Math.max(0, (istMin(endIso) - O) / L));
  const s = minutes == null || !startIso ? 0 : Math.min(e, Math.max(0, (istMin(startIso) - O) / L));
  return (
    <div className="flex items-center gap-2 text-xs text-muted" data-testid="oi-range">
      <span>{minutes == null ? "Session start" : startIso ? fmtTimeIST(startIso) : "—"}</span>
      <div className="relative h-1.5 flex-1 rounded-full bg-rule" aria-hidden="true">
        <div className="absolute inset-y-0 rounded-full bg-brass" style={{ left: `${s * 100}%`, width: `${Math.max(0.5, (e - s) * 100)}%` }} />
      </div>
      <span>{fmtTimeIST(endIso)}</span>
    </div>
  );
}

function OiExplorerBody({ large, mode, setMode, win, setWin }: {
  large: boolean; mode: OiMode; setMode: (m: OiMode) => void; win: string; setWin: (w: string) => void;
}) {
  const d = useDash();
  const colors = useChartColors();
  const obs = d.history.data?.observations ?? [];
  const newest = useMemo(() => windowEndIso(obs.map((o) => o.retrieved_at)), [obs]);
  const w = OI_WINDOWS.find((x) => x.id === win)!;
  const at = w.minutes == null || !newest ? undefined : windowStartIso(newest, w.minutes);
  const q = useQuery({
    queryKey: ["oiWindow", d.expiry, win, at, newest, d.range],
    queryFn: () => api.oiChange(d.expiry!, w.minutes == null ? "session_open" : "at", strikesParam(d.range), at, newest ?? undefined),
    enabled: !!d.expiry && !!newest, refetchInterval: 30_000, retry: false,
  });
  const res = q.data;
  const opt = useMemo(() => (res ? oiExplorerOption(res, mode, d.showCalls, d.showPuts, d.selected, colors) : null), [res, mode, d.showCalls, d.showPuts, d.selected, colors]);
  const st = res ? oiWindowStats(res.totals) : null;
  const chip = (on: boolean) => `widget-nodrag rounded-sm border px-2 ${large ? "min-h-9 text-sm" : "min-h-7 text-xs"} ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;
  return (
    <div className={`flex h-full min-h-0 flex-col gap-1 ${large ? "overflow-y-auto" : ""}`} data-testid="oi-explorer">
      <div role="group" aria-label="OI view" className="flex flex-wrap items-center gap-1">
        {OI_MODES.map((m) => <button key={m.id} type="button" title={m.title} aria-pressed={mode === m.id} onClick={() => setMode(m.id)} className={chip(mode === m.id)}>{m.label}</button>)}
      </div>
      <div className={large ? "min-h-[320px] flex-1" : "min-h-0 flex-1"}>
        {q.isPending && q.fetchStatus !== "idle" ? <p className="p-3 text-sm text-muted">Loading observations…</p>
          : q.error ? <EmptyState title="Could not load OI for this window">{String((q.error as Error).message)}</EmptyState>
          : !res || res.observations_available === 0 ? <EmptyState title="No observations stored for this expiry yet">Observations are stored each time a chain is fetched.</EmptyState>
          : opt ? <EChart option={opt} ariaLabel="Open interest by strike" onClick={(p) => { const k = Number(p.name); if (Number.isFinite(k)) d.select(k); }} />
          : null}
      </div>
      {large && <OiRangeTrack startIso={at ?? null} endIso={newest} minutes={w.minutes} />}
      <div role="group" aria-label="OI window" className="flex flex-wrap items-center gap-1">
        {OI_WINDOWS.map((x) => <button key={x.id} type="button" aria-pressed={win === x.id} onClick={() => setWin(x.id)} className={chip(win === x.id)}>{x.label}</button>)}
      </div>
      {res && st && !large && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4" data-testid="oi-window-stats">
          <div><span className="text-muted">Call OI </span><span className="num text-paper">{compactIN(st.ceOi)}</span> <span className="num text-muted">({signedUnits(st.ceChange)})</span></div>
          <div><span className="text-muted">Put OI </span><span className="num text-paper">{compactIN(st.peOi)}</span> <span className="num text-muted">({signedUnits(st.peChange)})</span></div>
          <div><span className="text-muted">PCR </span><span className="num text-paper">{fmt2(st.pcr)}</span> <span className="num text-muted">({st.pcrChange == null ? "—" : `${st.pcrChange >= 0 ? "+" : "−"}${Math.abs(st.pcrChange).toFixed(2)}`} in window)</span></div>
          <div title={st.pcrOiChangeNote ?? "Put OI change divided by call OI change"}><span className="text-muted">PCR of OI change </span><span className="num text-paper">{fmt2(st.pcrOiChange)}</span></div>
        </div>
      )}
      {large && st && <OiCards st={st} />}
      {res && (
        <p className="text-[11px] text-muted" data-testid="oi-window-note">
          {w.label}: compared with the stored sample at {res.baseline.at ? fmtTimeIST(res.baseline.at) : "—"}, now {res.current_at ? fmtTimeIST(res.current_at) : "—"}
          {res.underlying_change != null && <> · NIFTY {res.underlying_change >= 0 ? "+" : "−"}{fmtPrice(Math.abs(res.underlying_change))}</>}.
          {" "}Samples are stored about once a minute.{st?.pcrOiChangeNote ? ` PCR of OI change: ${st.pcrOiChangeNote}.` : ""}
          {res.warnings.map((x) => <span key={x} className="text-warn"> {x}</span>)}
        </p>
      )}
    </div>
  );
}

export function OiExplorerWidget() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OiMode>("both");
  const [win, setWin] = useState("all"); // the same choice is kept when the chart is opened full size
  const close = useCallback(() => setOpen(false), []);
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>click a bar to select a strike</span></Meta>}>
        <div className="flex h-full flex-col">
          <div className="mb-1 flex justify-end">
            <button type="button" onClick={() => setOpen(true)} aria-label="Open OI explorer full size" title="Open this chart full size"
              className="widget-nodrag inline-flex min-h-6 items-center rounded-sm border border-rule bg-slate-2 px-2 text-xs text-muted hover:border-brass hover:text-paper">⤢ Full</button>
          </div>
          <div className="min-h-0 flex-1">{!open && <OiExplorerBody large={false} mode={mode} setMode={setMode} win={win} setWin={setWin} />}</div>
        </div>
      </Body>
      {open && (
        <FullChart title="Open interest: change and total by window" onClose={close}
          footer="Pick a window to compare the OI now with the OI that long ago; the totals and PCR below the chart follow the same window.">
          <OiExplorerBody large mode={mode} setMode={setMode} win={win} setWin={setWin} />
        </FullChart>
      )}
    </ChainGuard>
  );
}

/** PCR at the ATM strike and over the whole chain, side by side with the strikes in view. */
export function PcrWidget() {
  const d = useDash();
  const atmRows = useMemo(() => d.rows.filter((r) => r.strike === d.atmStrike), [d.rows, d.atmStrike]);
  const lines = [
    { id: "atm", label: d.atmStrike == null ? "ATM strike" : `ATM strike ${fmtInt(d.atmStrike)}`, rows: atmRows },
    { id: "view", label: d.universeLabel, rows: d.view },
    { id: "all", label: `Overall: all ${d.rows.length} listed strikes`, rows: d.rows },
  ].map((l) => ({ ...l, t: computeTotals(l.rows) }));
  const f = (v: number | null) => (v == null ? "—" : v.toFixed(2));
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain" />}>
        <div className="h-full overflow-auto" data-testid="pcr-widget">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="px-2 py-1 text-left font-medium">Strikes</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">PCR (OI)</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">PCR (volume)</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Put OI</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Call OI</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-rule">
                  <th scope="row" className="px-2 py-1 text-left font-medium text-paper">{l.label}</th>
                  <td className="num px-2 py-1 text-right text-paper">{f(pcr(l.t.peOi, l.t.ceOi))}</td>
                  <td className="num px-2 py-1 text-right">{f(pcr(l.t.peVolume, l.t.ceVolume))}</td>
                  <td className="num px-2 py-1 text-right">{l.t.peOi == null ? "—" : compactIN(l.t.peOi)}</td>
                  <td className="num px-2 py-1 text-right">{l.t.ceOi == null ? "—" : compactIN(l.t.ceOi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 pt-1 text-[11px] text-muted">PCR = total put ÷ total call. A value is "—" when the data is missing, never zero.</p>
        </div>
      </Body>
    </ChainGuard>
  );
}

export interface WidgetDef {
  id: string;
  title: string;
  render: () => ReactNode;
  /** default grid box on a 12-column grid (row height 36px) */
  w: number; h: number; x: number; y: number; minW: number; minH: number;
}

export const WIDGETS: WidgetDef[] = [
  { id: "spot", title: "NIFTY 50 — snapshot observations", render: () => <SpotWidget />, x: 0, y: 0, w: 4, h: 9, minW: 3, minH: 5 },
  { id: "oi", title: "Open interest by strike", render: () => <OiWidget />, x: 4, y: 0, w: 4, h: 9, minW: 3, minH: 5 },
  { id: "oiChange", title: "OI change by strike", render: () => <OiChangeWidget />, x: 8, y: 0, w: 4, h: 9, minW: 3, minH: 5 },
  { id: "chain", title: "Option chain", render: () => <ChainWidget />, x: 0, y: 9, w: 6, h: 12, minW: 4, minH: 6 },
  { id: "premium", title: "Total premium", render: () => <PremiumWidget />, x: 6, y: 9, w: 3, h: 12, minW: 3, minH: 5 },
  { id: "decay", title: "Premium decay", render: () => <DecayWidget />, x: 9, y: 9, w: 3, h: 12, minW: 3, minH: 5 },
  { id: "oiTotal", title: "Total OI — calls vs puts", render: () => <OiTotalWidget />, x: 0, y: 21, w: 3, h: 8, minW: 2, minH: 5 },
  { id: "oiChangeTotal", title: "Total OI change — calls vs puts", render: () => <OiChangeTotalWidget />, x: 3, y: 21, w: 3, h: 8, minW: 2, minH: 5 },
  { id: "volume", title: "Volume by strike", render: () => <VolumeWidget />, x: 0, y: 29, w: 6, h: 8, minW: 3, minH: 5 },
  { id: "straddle", title: "ATM straddle", render: () => <StraddleWidget />, x: 0, y: 29, w: 4, h: 8, minW: 3, minH: 5 },
  { id: "pcr", title: "PCR: ATM and overall", render: () => <PcrWidget />, x: 0, y: 29, w: 6, h: 7, minW: 4, minH: 5 },
  { id: "levels", title: "Key levels", render: () => <LevelsWidget />, x: 6, y: 21, w: 6, h: 8, minW: 3, minH: 5 },
  { id: "oiIntraday", title: "Intraday OI change", render: () => <OiIntradayWidget />, x: 0, y: 37, w: 6, h: 12, minW: 4, minH: 7 },
  { id: "oiHeatmap", title: "OI change heatmap", render: () => <OiHeatmapWidget />, x: 6, y: 37, w: 6, h: 12, minW: 4, minH: 7 },
  { id: "oiConcentration", title: "OI concentration", render: () => <OiConcentrationWidget />, x: 0, y: 49, w: 5, h: 10, minW: 3, minH: 6 },
  { id: "priceOi", title: "Price and OI", render: () => <PriceOiWidget />, x: 5, y: 49, w: 7, h: 10, minW: 4, minH: 6 },
  { id: "detail", title: "Strike detail", render: () => <DetailWidget />, x: 9, y: 29, w: 3, h: 8, minW: 2, minH: 4 },
];

/** First screen: the nine widgets of the reference layout; the rest are one click away in "Add widget". */
export const DEFAULT_ACTIVE = ["spot", "oi", "oiChange", "chain", "premium", "decay", "oiTotal", "oiChangeTotal", "levels", "pcr"];

/** Widgets added after the first release: offered once to layouts saved earlier, so they are not hidden behind "Add widget". */
export const NEW_DEFAULT_WIDGETS = ["pcr"];
