import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST, MISSING } from "../lib/format";
import { place, polyline, type PositionMonitorData } from "../lib/positionMonitor";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const inr = (v: number | null | undefined) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}₹${Math.round(Math.abs(v)).toLocaleString("en-IN")}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const LEVEL: Record<string, string> = { ok: "bg-slate-2 text-muted", watch: "bg-warn/15 text-warn", alert: "bg-down/15 text-down" };

function Tile({ label, value, sub, cls = "", id }: { label: string; value: string; sub: string; cls?: string; id: string }) {
  return (
    <div className="rounded-sm bg-slate-2 px-3 py-2" data-testid={id}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function AttrRow({ label, v, max, id }: { label: string; v: number; max: number; id: string }) {
  const w = max > 0 ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return (
    <div className="grid grid-cols-[9.5rem_1fr_3.5rem] items-center gap-2 text-xs" data-testid={id}>
      <span className="text-muted">{label}</span>
      <div className="relative h-3.5"><div className="absolute inset-y-0 left-1/2 border-l border-rule" /><div className={`absolute top-0.5 h-2.5 ${v >= 0 ? "bg-up" : "bg-down"}`} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} /></div>
      <span className={`num text-right ${tone(v)}`}>{sg(v)}</span>
    </div>
  );
}

function Distance({ d }: { d: NonNullable<PositionMonitorData["distance"]> }) {
  const reach = Math.max(50, (d.restrike_points ?? 0) * 1.5, Math.abs(d.points) * 1.25, d.expected_move * 1.25);
  const x = (v: number) => 320 + (v / reach) * 280;
  const bandL = x(-d.expected_move), bandR = x(d.expected_move);
  return (
    <div data-testid="pm-distance">
      <svg viewBox="0 0 640 92" width="100%" role="img" aria-label={`NIFTY ${d.spot.toFixed(0)} is ${Math.abs(d.points).toFixed(0)} points ${d.points < 0 ? "below" : "above"} the ${d.strike} strike`}>
        <rect x={bandL} y="34" width={bandR - bandL} height="22" fill="var(--slate-2)" />
        <line x1="40" y1="45" x2="600" y2="45" stroke="var(--rule)" />
        <line x1="320" y1="26" x2="320" y2="64" stroke="var(--paper)" strokeWidth="1.5" />
        {d.restrike_points != null && [-1, 1].map((s) => <line key={s} x1={x(s * d.restrike_points!)} y1="26" x2={x(s * d.restrike_points!)} y2="64" stroke="var(--down)" strokeDasharray="4 3" />)}
        <circle cx={x(d.points)} cy="45" r="7" fill="var(--warn)" />
        <text x="320" y="18" textAnchor="middle" fontSize="12" fill="var(--paper)">strike {d.strike}</text>
        {d.restrike_points != null && [-1, 1].map((s) => <text key={s} x={x(s * d.restrike_points!)} y="18" textAnchor="middle" fontSize="12" fill="var(--down)">re-strike {s < 0 ? "−" : "+"}{d.restrike_points}</text>)}
        <text x={x(d.points)} y="82" textAnchor="middle" fontSize="12" fill="var(--warn)">NIFTY {d.spot.toFixed(0)} ({sg(d.points, 0)})</text>
        <text x="600" y="82" textAnchor="end" fontSize="11" fill="var(--muted)">shaded: expected move to the close (±{d.expected_move.toFixed(0)})</text>
      </svg>
      <p className="text-xs text-muted">
        {d.share_of_restrike != null ? `${Math.round(d.share_of_restrike * 100)}% of the way to the re-strike, ` : ""}
        {d.share_of_expected != null ? `${d.share_of_expected.toFixed(2)} of the expected move to the close (${d.minutes_left} minutes left).` : ""}
      </p>
    </div>
  );
}

function PremiumGauge({ p }: { p: NonNullable<PositionMonitorData["premium"]> }) {
  const lo = -15, hi = Math.max(45, (p.loss_pct ?? 0) * 1.2);
  const x = (v: number) => 40 + (place(v, lo, hi) / 100) * 560;
  const loss = p.loss_pct;
  return (
    <div data-testid="pm-premium-gauge">
      <svg viewBox="0 0 640 66" width="100%" role="img" aria-label={`The position is ${loss == null ? "unknown" : loss.toFixed(1)}% against its entry premium`}>
        <rect x="40" y="24" width="560" height="14" fill="var(--slate-2)" />
        <rect x={x(p.watch_pct)} y="24" width={x(p.stop_pct) - x(p.watch_pct)} height="14" fill="var(--warn)" fillOpacity="0.25" />
        <rect x={x(p.stop_pct)} y="24" width={600 - x(p.stop_pct)} height="14" fill="var(--down)" fillOpacity="0.25" />
        <line x1={x(0)} y1="18" x2={x(0)} y2="44" stroke="var(--paper)" strokeWidth="1.5" />
        {loss != null && <circle cx={x(loss)} cy="31" r="6" fill={loss >= p.stop_pct ? "var(--down)" : loss >= p.watch_pct ? "var(--warn)" : "var(--up)"} />}
        <text x={x(0)} y="14" textAnchor="middle" fontSize="12" fill="var(--paper)">{p.credit ? "sold" : "bought"} {Math.abs(p.entry).toFixed(1)}</text>
        {loss != null && <text x={x(loss)} y="60" textAnchor="middle" fontSize="12" fill="var(--paper)">now {Math.abs(p.now).toFixed(1)} ({sg(loss)}%)</text>}
        <text x={x(p.watch_pct)} y="60" textAnchor="middle" fontSize="11" fill="var(--warn)">watch {p.watch_pct}%</text>
        <text x={Math.min(588, x(p.stop_pct) + 50)} y="14" textAnchor="middle" fontSize="11" fill="var(--down)">stop zone {p.stop_pct}%</text>
      </svg>
    </div>
  );
}

function Chart({ s }: { s: NonNullable<PositionMonitorData["series"]> }) {
  const all = [...s.theta, ...s.spot, ...s.vol, ...s.total.filter((v): v is number => v != null), 0];
  const lo = Math.min(...all), hi = Math.max(...all), w = 560, h = 90;
  const zero = h - ((0 - lo) / (hi - lo || 1)) * h;
  return (
    <svg viewBox="0 0 640 124" width="100%" role="img" aria-label="Time income, NIFTY cost and the position's result since entry" data-testid="pm-chart">
      <g transform="translate(40,8)">
        <line x1="0" y1={zero} x2={w} y2={zero} stroke="var(--rule)" strokeDasharray="3 3" />
        <polyline fill="none" stroke="var(--up)" strokeWidth="1.5" points={polyline(s.theta, lo, hi, w, h)} />
        <polyline fill="none" stroke="var(--down)" strokeWidth="1.5" points={polyline(s.spot, lo, hi, w, h)} />
        <polyline fill="none" stroke="var(--paper)" strokeWidth="2" points={polyline(s.total, lo, hi, w, h)} />
      </g>
      <text x="40" y="118" fontSize="11" fill="var(--muted)">{s.t.length ? fmtTimeIST(s.t[0]).slice(0, 5) : ""}</text>
      <text x="600" y="118" textAnchor="end" fontSize="11" fill="var(--muted)">{s.t.length ? fmtTimeIST(s.t[s.t.length - 1]).slice(0, 5) : ""}</text>
      <text x="604" y="14" fontSize="11" fill="var(--muted)">{hi.toFixed(1)}</text>
      <text x="604" y="104" fontSize="11" fill="var(--muted)">{lo.toFixed(1)}</text>
    </svg>
  );
}

/** What the running strategy's open legs have earned from time, paid to NIFTY's move and to volatility since they were entered, and where they stand against their limits. Every figure is the server's (paper only). */
export function PositionMonitor() {
  const q = useQuery({ queryKey: ["positionMonitor"], queryFn: () => api.runningMonitor(), refetchInterval: 15_000, retry: false });
  const d = q.data;
  if (q.isPending) return <p role="status" className="mb-2 rounded-sm bg-slate-2 px-3 py-2 text-xs text-muted" data-testid="pm-loading">Loading the position monitor…</p>;
  if (q.isError || !d) return <p role="alert" className="mb-2 rounded-sm bg-slate-2 px-3 py-2 text-xs text-down" data-testid="pm-error">The position monitor could not be loaded{q.error instanceof Error ? `: ${q.error.message}` : ""}.</p>;
  if (!d.available || !d.attribution || !d.pnl || !d.premium || !d.delta || !d.status) {
    return <p role="status" className="mb-2 rounded-sm bg-slate-2 px-3 py-2 text-xs text-muted" data-testid="pm-unavailable">Position monitor: {d.reason ?? "no reading yet"}</p>;
  }
  const a = d.attribution;
  const max = Math.max(Math.abs(a.theta), Math.abs(a.vol), Math.abs(a.spot), Math.abs(a.other), Math.abs(a.total), 0.01);
  return (
    <section aria-label="Position monitor" className="mb-2 rounded-sm bg-slate-2 px-3 py-3 text-xs" data-testid="position-monitor">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-paper">Position monitor</h3>
          <p className="text-muted" data-testid="pm-legs">{(d.legs ?? []).map((l) => `${l.label} ${l.entry.toFixed(2)}`).join(" · ")}{d.since ? ` · followed since ${fmtTimeIST(d.since).slice(0, 5)}` : ""} · as of {fmtTimeIST(d.as_of).slice(0, 5)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`rounded-sm px-2 py-0.5 ${LEVEL[d.status.level]}`} data-testid="pm-status">{d.status.text}</span>
          <span className="rounded-sm bg-slate px-2 py-0.5 text-muted">Paper · server, every minute</span>
        </div>
      </div>
      {d.live === false && <p className="mt-2 text-warn" data-testid="pm-notlive">The stream is not live or the market is closed: these are the last readings, not the market now.</p>}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile id="pm-pnl" label="P&L since entry" value={`${sg(d.pnl.points)} pts`} sub={`${inr(d.pnl.rupees)} per lot, before costs`} cls={tone(d.pnl.points)} />
        <Tile id="pm-premium" label="Against entry premium" value={d.premium.loss_pct == null ? MISSING : `${sg(d.premium.loss_pct)}%`} sub={`${Math.abs(d.premium.now).toFixed(1)} now, ${Math.abs(d.premium.entry).toFixed(1)} ${d.premium.credit ? "sold" : "paid"}`} cls={d.premium.loss_pct != null && d.premium.loss_pct >= d.premium.watch_pct ? "text-warn" : "text-paper"} />
        <Tile id="pm-delta" label="Net delta" value={sg(d.delta.net, 2)} sub={`about ${sg(d.delta.units, 0)} units: ${d.delta.net > 0 ? "gains if NIFTY rises" : d.delta.net < 0 ? "gains if NIFTY falls" : "flat to NIFTY"}`} />
        <Tile id="pm-ratio" label="NIFTY cost / time income" value={a.ratio == null ? MISSING : `${a.ratio.toFixed(1)}×`} sub={a.ratio == null ? (a.steps < 15 ? "needs 15 minutes of readings" : "time income not positive yet") : `${Math.abs(a.spot).toFixed(1)} paid, ${a.theta.toFixed(1)} earned`} cls={a.ratio != null && a.ratio > 1 ? "text-warn" : "text-paper"} />
      </div>

      <h4 className="mt-4 text-xs font-semibold text-paper">Where the P&amp;L came from</h4>
      <div className="mt-1 space-y-1" data-testid="pm-attribution">
        <AttrRow id="pm-attr-theta" label="Time passing (theta)" v={a.theta} max={max} />
        <AttrRow id="pm-attr-vol" label="Volatility (vega and cross)" v={a.vol} max={max} />
        <AttrRow id="pm-attr-spot" label="NIFTY move (delta + gamma)" v={a.spot} max={max} />
        <AttrRow id="pm-attr-other" label="Other (residual, entry)" v={a.other} max={max} />
        <div className="grid grid-cols-[9.5rem_1fr_3.5rem] items-center gap-2 border-t border-rule pt-1 text-xs" data-testid="pm-attr-total"><span className="font-semibold text-paper">Total</span><span /><span className={`num text-right font-semibold ${tone(a.total)}`}>{sg(a.total)}</span></div>
      </div>

      {d.distance && <><h4 className="mt-4 text-xs font-semibold text-paper">Distance from your strike</h4><Distance d={d.distance} /></>}
      <h4 className="mt-3 text-xs font-semibold text-paper">Premium against your entry</h4>
      <PremiumGauge p={d.premium} />
      {d.series && d.series.t.length > 1 && <><h4 className="mt-3 text-xs font-semibold text-paper">Time income and NIFTY cost since entry</h4><Chart s={d.series} /><p className="text-[11px] text-muted"><span className="text-up">green</span>: time income · <span className="text-down">red</span>: NIFTY move · <span className="text-paper">white</span>: the position's result</p></>}

      {d.status.reasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-paper" data-testid="pm-reasons">{d.status.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {(d.events?.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-0.5 border-t border-rule pt-2" data-testid="pm-events">
          {d.events!.map((e, i) => <li key={`${e.at}-${i}`} className="grid grid-cols-[3.2rem_1fr] gap-2"><span className="num text-muted">{fmtTimeIST(e.at).slice(0, 5)}</span><span className="text-paper">{e.text}</span></li>)}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted" data-testid="pm-limits">{d.limits}</p>
    </section>
  );
}
