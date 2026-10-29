import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { EChart, useChartColors } from "../EChart";
import { ChainTable } from "../ChainTable";
import { Button, EmptyState, SourceTag } from "../ui";
import { useDash } from "./DashContext";
import { atmStraddle, compactIN, maxPain, pcr } from "../../lib/analytics";
import {
  decayOption, oiChangeBarOption, oiHeatmapOption, premiumOption, spotOption, straddleOption, strikeBarOption,
  totalsBarOption, type StrikeMetric,
} from "../../lib/chartOptions";
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
  const { at, age } = useLastSample();
  const fresh = age != null && age <= 180;
  const late = age != null && age > 180 && age <= 600;
  const cls = fresh ? "border-up/50 text-up" : late ? "border-warn/50 text-warn" : "border-info/50 text-info";
  const text = fresh ? "Sampled live" : late ? "Sampling delayed" : "Stored (last session)";
  return (
    <>
      <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs font-medium ${cls}`}
        title="These charts plot the option-chain samples stored every minute in market hours (not individual ticks).">{text}</span>
      {at && <span>last sample {fmtTimeIST(at)}</span>}
    </>
  );
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
  return (
    <ChainGuard>
      <Body footer={<Meta kind="chain">{baseline}</Meta>}>
        <EChart option={opt} ariaLabel={`${label} by strike`}
          onClick={(p) => { const s = Number(p.name); if (Number.isFinite(s)) d.select(s); }} />
      </Body>
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

export const OiWidget = () => <StrikeBars metric="oi" label="Open interest" />;
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

function TimeSeries({ build, label }: {
  build: (obs: Observation[], c: ReturnType<typeof useChartColors>) => ReturnType<typeof premiumOption>;
  label: string;
}) {
  const d = useDash();
  const colors = useChartColors();
  const obs = d.history.data?.observations ?? [];
  const opt = useMemo(() => build(obs, colors), [build, obs, colors]);
  const distinct = d.history.data?.distinct_observations ?? 0;
  return (
    <ChainGuard>
      <Body footer={<Meta kind="history"><span>{obs.length} stored snapshot{obs.length === 1 ? "" : "s"}</span></Meta>}>
        {d.history.isPending ? (
          <p className="p-3 text-sm text-muted">Loading stored snapshots…</p>
        ) : obs.length < 2 ? (
          <EmptyState title="Not enough stored snapshots to draw a line">
            {obs.length} snapshot stored for this expiry and strike range. A line needs at least two. Each
            “Refresh snapshot” stores one more; during market hours the stream also keeps the table live.
          </EmptyState>
        ) : (
          <div className="flex h-full flex-col">
            {distinct < 2 && (
              <p className="mb-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                All {obs.length} stored snapshots carry identical values (captured with the market closed),
                so the line is flat. It will move once snapshots from market hours are stored.
              </p>
            )}
            <div className="min-h-0 flex-1"><EChart option={opt} ariaLabel={label} /></div>
          </div>
        )}
      </Body>
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
  return <TimeSeries build={build} label="Premium decay versus first stored snapshot" />;
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
  { id: "levels", title: "Key levels", render: () => <LevelsWidget />, x: 6, y: 21, w: 6, h: 8, minW: 3, minH: 5 },
  { id: "oiIntraday", title: "Intraday OI change", render: () => <OiIntradayWidget />, x: 0, y: 37, w: 6, h: 12, minW: 4, minH: 7 },
  { id: "oiHeatmap", title: "OI change heatmap", render: () => <OiHeatmapWidget />, x: 6, y: 37, w: 6, h: 12, minW: 4, minH: 7 },
  { id: "oiConcentration", title: "OI concentration", render: () => <OiConcentrationWidget />, x: 0, y: 49, w: 5, h: 10, minW: 3, minH: 6 },
  { id: "priceOi", title: "Price and OI", render: () => <PriceOiWidget />, x: 5, y: 49, w: 7, h: 10, minW: 4, minH: 6 },
  { id: "detail", title: "Strike detail", render: () => <DetailWidget />, x: 9, y: 29, w: 3, h: 8, minW: 2, minH: 4 },
];

/** First screen: the nine widgets of the reference layout; the rest are one click away in "Add widget". */
export const DEFAULT_ACTIVE = ["spot", "oi", "oiChange", "chain", "premium", "decay", "oiTotal", "oiChangeTotal", "levels"];
