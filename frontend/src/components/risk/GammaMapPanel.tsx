import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fmtInt, fmtTimeIST, MISSING } from "../../lib/format";
import { crore, fetchGammaMap, type GammaMap, LEVEL_TEXT, LEVEL_TONE, profileOption } from "../../lib/gammaMap";
import { timeLinesOption, type Line } from "../../lib/priceCharts";
import { EChart, useChartColors } from "../EChart";

const sel = "min-h-9 rounded-sm border border-rule bg-slate-2 px-2 text-xs text-paper";

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-sm border border-rule/60 bg-slate-2 p-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-base font-semibold ${tone ?? "text-paper"}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/** Gamma by strike, gamma since the open (with its average) and the sudden-move ("gamma blast") reading, from the stored 5-minute snapshots. Modelled exposure, descriptive only. */
export function GammaMapPanel({ expiries }: { expiries: string[] }) {
  const [pick, setPick] = useState<string>("");
  const [universe, setUniverse] = useState<"dynamic" | "full">("dynamic");
  const expiry = pick && expiries.includes(pick) ? pick : (expiries[0] ?? "");
  const q = useQuery({ queryKey: ["gamma-map", expiry, universe], queryFn: () => fetchGammaMap(expiry, universe), enabled: !!expiry, refetchInterval: 60_000, retry: false, placeholderData: keepPreviousData });
  const c = useChartColors();
  const d: GammaMap | undefined = q.data;
  const ok = d?.status === "ok";
  const last = ok ? d!.points[d!.points.length - 1] : undefined;

  const charts = useMemo(() => {
    if (!d || d.status !== "ok" || d.points.length < 2) return null;
    const times = d.points.map((p) => new Date(p.at).getTime());
    const meanAbs = d.average?.abs?.mean ?? null;
    const gam: Line[] = [
      { name: "Near-the-money net", color: c.brass, data: d.points.map((p) => p.near_net), fmt: (v) => crore(v, 1) },
      { name: "Absolute (right)", color: c.info, axis: 1, data: d.points.map((p) => p.abs), fmt: (v) => v.toFixed(0) },
      ...(meanAbs == null ? [] : [{ name: "Average absolute (right)", color: c.info, axis: 1 as const, dotted: true, data: d.points.map(() => meanAbs), fmt: (v: number) => v.toFixed(0) }]),
    ];
    const idx: Line[] = [
      { name: "NIFTY", color: c.paper, data: d.points.map((p) => p.spot), fmt: (v) => fmtInt(v) },
      { name: "Gamma flip", color: c.brass, dotted: true, data: d.points.map((p) => p.flip), fmt: (v) => fmtInt(v) },
      { name: "Call wall", color: c.up, dotted: true, data: d.points.map((p) => p.call_wall), fmt: (v) => fmtInt(v) },
      { name: "Put wall", color: c.down, dotted: true, data: d.points.map((p) => p.put_wall), fmt: (v) => fmtInt(v) },
    ];
    return {
      gam: timeLinesOption(times, gam, c, null, { leftFmt: (v) => crore(v, 0), rightFmt: (v) => v.toFixed(0), zeroLine: true }),
      idx: timeLinesOption(times, idx, c, null, { leftFmt: (v) => fmtInt(v) }),
    };
  }, [d, c]);
  const profile = useMemo(() => (ok ? profileOption(d!.profile, d!.spot ?? null, last?.flip ?? null, c) : null), [d, ok, last, c]);

  const b = d?.blast;
  const avg = d?.average;
  const flipDist = last?.flip != null && last.spot ? ((last.spot - last.flip) / last.spot) * 100 : null;
  return (
    <section aria-label="Gamma map and sudden-move reading" className="rounded-xl border border-rule bg-ink/40 p-3" data-testid="gamma-map">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Gamma map and sudden-move risk <span className="font-normal text-muted">· whole chain, since the open</span></h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-muted">Expiry <select className={sel} aria-label="Gamma map expiry" value={expiry} onChange={(e) => setPick(e.target.value)} data-testid="gamma-expiry">{expiries.map((e) => <option key={e} value={e}>{e}</option>)}</select></label>
          <label className="text-muted">Strikes <select className={sel} aria-label="Gamma map strikes" value={universe} onChange={(e) => setUniverse(e.target.value as "dynamic" | "full")} data-testid="gamma-universe"><option value="dynamic">Near the money (±10)</option><option value="full">Full chain</option></select></label>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted">Modelled gamma exposure of the option chain in ₹ crore per 1% move. Calls count positive and puts negative, an assumed sign convention, not observed dealer positions. "Gamma blast" here means a sudden NIFTY move; the reading says how much the stored conditions favour one, never which way. Descriptive, provisional, not a trading signal.</p>
      {expiries.length === 0 ? <p className="mt-2 text-sm text-muted" data-testid="gamma-empty">No expiry is available yet.</p>
        : q.isError ? <p role="alert" className="mt-2 text-sm text-down" data-testid="gamma-error">{q.error instanceof Error ? q.error.message : "The gamma map could not be loaded."}</p>
        : !d ? <p className="mt-2 text-sm text-muted" data-testid="gamma-loading">Loading the gamma map…</p>
        : !ok ? <p className="mt-2 text-sm text-muted" data-testid="gamma-unavailable">No gamma map for {expiry}: {d.status}. It needs a stored session of this expiry with open interest and a solvable chain.</p>
        : (
          <>
            {b?.status === "ok" && (
              <div className="mt-2 rounded-lg border border-rule p-3" data-testid="gamma-blast">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-sm font-semibold text-paper">Sudden-move risk</span>
                  <span className={`num text-2xl font-semibold ${LEVEL_TONE[b.level ?? ""] ?? "text-muted"}`} data-testid="gamma-blast-score">{b.score == null ? MISSING : b.score.toFixed(0)}</span>
                  <span className={`text-sm font-semibold ${LEVEL_TONE[b.level ?? ""] ?? "text-muted"}`} data-testid="gamma-blast-level">{b.level ? LEVEL_TEXT[b.level] : MISSING}</span>
                  <span className="text-[11px] text-muted">of 100 · {b.coverage_pct}% of the inputs available · as of {d.snapshot_at ? fmtTimeIST(d.snapshot_at) : MISSING} IST</span>
                </div>
                {b.sudden?.latest_is_sudden && <p className="mt-1 rounded bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="gamma-sudden-now">The latest 5-minute step was a sudden move: at least {b.sudden.threshold_pct?.toFixed(2)}% of NIFTY.</p>}
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2" aria-label="What the reading is made of">
                  {b.components.map((x) => (
                    <li key={x.key} className="text-xs" data-testid={`gamma-comp-${x.key}`}>
                      <div className="flex justify-between"><span className="text-paper">{x.label} <span className="text-muted">· weight {x.weight}</span></span><span className="num text-paper">{x.value == null ? MISSING : `${Math.round(x.value * 100)}%`}</span></div>
                      <div className="mt-0.5 h-1.5 rounded bg-slate-2"><div className="h-1.5 rounded bg-brass" style={{ width: `${(x.value ?? 0) * 100}%` }} /></div>
                      <div className="mt-0.5 text-[11px] leading-snug text-muted">{x.detail}</div>
                    </li>
                  ))}
                </ul>
                {b.sudden && (
                  <div className="mt-2 text-xs" data-testid="gamma-events">
                    <div className="text-muted">Sudden moves so far this session (a 5-minute step of at least {b.sudden.threshold_pct == null ? MISSING : `${b.sudden.threshold_pct.toFixed(2)}%`}: the larger of 0.15% and three times the typical step{b.sudden.typical_step_pct == null ? "" : `, ${b.sudden.typical_step_pct.toFixed(3)}%`}): {b.sudden.events.length}</div>
                    {b.sudden.events.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {b.sudden.events.map((e) => <li key={e.at} className="text-paper">{fmtTimeIST(e.at)} · {e.direction} {Math.abs(e.move).toFixed(0)} points ({e.pct > 0 ? "+" : "−"}{Math.abs(e.pct).toFixed(2)}%){e.short_gamma_before ? " · near-the-money gamma was short before it" : e.short_gamma_before === false ? " · gamma was long before it" : ""}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
            {b?.status === "unavailable" && <p className="mt-2 text-sm text-muted" data-testid="gamma-blast-unavailable">{b.message}</p>}
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="gamma-average">
              <Tile label="Absolute gamma now" value={avg?.abs ? avg.abs.now.toFixed(0) : MISSING} sub={avg?.abs ? `average ${avg.abs.mean.toFixed(0)} · ${avg.abs.now_vs_mean == null ? MISSING : `${avg.abs.now_vs_mean.toFixed(2)}×`}` : undefined} />
              <Tile label="Range since open" value={avg?.abs ? `${avg.abs.min.toFixed(0)} – ${avg.abs.max.toFixed(0)}` : MISSING} sub={avg?.abs?.peak_at ? `peak ${fmtTimeIST(avg.abs.peak_at)}` : undefined} />
              <Tile label="Near-the-money net" value={avg?.near_net ? crore(avg.near_net.now) : MISSING} sub={avg?.near_net ? `average ${crore(avg.near_net.mean)}` : undefined} tone={avg?.near_net ? (avg.near_net.now < 0 ? "text-down" : "text-up") : undefined} />
              <Tile label="Time short gamma" value={avg?.negative_share == null ? MISSING : `${Math.round(avg.negative_share * 100)}%`} sub="near-the-money net below zero" />
              <Tile label="Gamma flip" value={last?.flip == null ? MISSING : fmtInt(last.flip)} sub={flipDist == null ? "none within ±8%" : `NIFTY ${flipDist >= 0 ? "above" : "below"} by ${Math.abs(flipDist).toFixed(2)}%`} />
              <Tile label="Walls" value={last ? `${last.put_wall == null ? MISSING : fmtInt(last.put_wall)} / ${last.call_wall == null ? MISSING : fmtInt(last.call_wall)}` : MISSING} sub="put wall / call wall" />
            </div>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-muted">Gamma by strike, ₹ crore per 1% move (latest snapshot)</div>
                <div className="h-[300px]" data-testid="gamma-profile">{profile && <EChart option={profile} ariaLabel="Gamma exposure by strike: calls, puts and net" />}</div>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted">Gamma since the open (5-minute snapshots)</div>
                <div className="h-[300px]" data-testid="gamma-history">{charts ? <EChart group="gamma" option={charts.gam} ariaLabel="Near-the-money net and absolute gamma since the open" /> : <p className="text-sm text-muted">Needs at least two stored snapshots.</p>}</div>
              </div>
            </div>
            {charts && (
              <div className="mt-3">
                <div className="mb-1 text-xs text-muted">NIFTY, the gamma flip and the walls through the session</div>
                <div className="h-[240px]"><EChart group="gamma" option={charts.idx} ariaLabel="NIFTY with the gamma flip and the call and put walls" /></div>
              </div>
            )}
            <p className="mt-2 text-[11px] text-muted" data-testid="gamma-source">
              Session {d.session} · stored 5-minute snapshots, latest {d.snapshot_at ? `${fmtTimeIST(d.snapshot_at)} IST` : MISSING} · {d.hours_to_expiry?.toFixed(1)} h to expiry at that time · {d.units}. {d.skipped && d.skipped.length > 0 ? `${d.skipped.length} snapshot(s) could not be solved and are left out. ` : ""}{b?.note}
            </p>
          </>
        )}
    </section>
  );
}
