import { useMemo, useState } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { MISSING } from "../../lib/format";
import type { Intelligence, StockFuturesRow } from "../../lib/intelligence";
import { EChart, useChartColors } from "../EChart";

const sgn = (v: number | null | undefined, d = 2) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-paper" : v > 0 ? "text-up" : "text-down");
const BUILDUP_TONE: Record<string, string> = { "Long buildup": "bg-up/20 text-up", "Short covering": "bg-up/10 text-up", "Short buildup": "bg-down/20 text-down", "Long unwinding": "bg-down/10 text-down" };
const BUILDUP_HELP: Record<string, string> = {
  "Long buildup": "price up, open interest up", "Short buildup": "price down, open interest up", "Short covering": "price up, open interest down", "Long unwinding": "price down, open interest down",
};

function Tile({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="min-w-0 rounded-lg bg-slate-2 px-3 py-2"><div className="text-[11px] text-muted">{label}</div><div className={`num text-lg font-semibold ${t ?? "text-paper"}`}>{value}</div>{sub && <div className="text-[11px] leading-snug text-muted">{sub}</div>}</div>;
}

function Chip({ label }: { label: string | null }) {
  return label ? <span title={BUILDUP_HELP[label]} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${BUILDUP_TONE[label] ?? "bg-slate-2 text-muted"}`}>{label}</span> : <span className="text-muted">{MISSING}</span>;
}

/** Stock futures of the NIFTY 50 and rollover, from the live feed. Open interest change is against the first reading of the session. */
export function StockFuturesPanel({ d }: { d: Intelligence }) {
  const sf = d.stock_futures;
  const c = useChartColors();
  const [sort, setSort] = useState<"oi" | "price" | "rollover">("oi");
  const rows = useMemo(() => {
    const r = [...(sf?.rows ?? [])];
    const key = (x: StockFuturesRow) => (sort === "oi" ? x.oi_change_pct : sort === "price" ? x.price_change_pct : x.rollover_pct);
    return r.sort((a, b) => Math.abs(key(b) ?? -1) - Math.abs(key(a) ?? -1));
  }, [sf, sort]);
  const bars = useMemo(() => {
    const withOi = (sf?.rows ?? []).filter((x) => x.oi_change_pct != null).sort((a, b) => (a.oi_change_pct as number) - (b.oi_change_pct as number));
    if (withOi.length === 0) return null;
    const pick = withOi.length > 18 ? [...withOi.slice(0, 9), ...withOi.slice(-9)] : withOi;
    return { n: pick.length, option: {
      animation: false, grid: { left: 8, right: 46, top: 6, bottom: 22, containLabel: true },
      tooltip: { trigger: "item", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 }, formatter: (p: unknown) => {
        const r = pick[(p as { dataIndex: number }).dataIndex]!;
        return `<b>${r.symbol}</b><br/>OI ${sgn(r.oi_change_pct, 1)}% (${r.oi_change == null ? MISSING : (r.oi_change >= 0 ? "+" : "−") + Math.abs(r.oi_change).toLocaleString("en-IN")})<br/>Price ${sgn(r.price_change_pct)}%<br/>${r.buildup ?? "no label"}`;
      } },
      xAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.rule, opacity: 0.4 } } },
      yAxis: { type: "category", data: pick.map((r) => r.symbol), axisLabel: { color: c.paper, fontSize: 11 }, axisTick: { show: false } },
      series: [{ type: "bar", barMaxWidth: 14, data: pick.map((r) => ({ value: r.oi_change_pct, itemStyle: { color: r.buildup === "Long buildup" || r.buildup === "Short covering" ? c.up : r.buildup ? c.down : c.muted, borderRadius: 3 } })),
        label: { show: true, position: "right", color: c.paper, fontSize: 10, formatter: (p: { value: number }) => `${p.value > 0 ? "+" : ""}${p.value.toFixed(1)}%` } }],
    } as EChartsCoreOption };
  }, [sf, c]);

  if (!sf) return <section aria-label="Stock futures and rollover" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm text-muted" data-testid="sf-panel">Stock futures and rollover: not available in this reading.</section>;
  const nr = sf.nifty;
  const counts = sf.buildup_counts ?? {};
  return (
    <section aria-label="Stock futures and rollover" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="sf-panel">
      <h2 className="text-sm font-semibold text-paper">Stock futures and rollover <span className="font-normal text-muted">· NIFTY 50 stocks, current month against next month</span></h2>
      <p className="mt-0.5 text-[13px] leading-snug text-muted">Which stocks have positions being added (open interest up) or closed, with price. Rollover is how much has moved to the next month; a rise into expiry is normal.</p>
      {sf.covered === 0 ? (
        <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-paper" role="status" data-testid="sf-none">No stock future has a fresh quote right now. {sf.tokens_note ?? ""} Nothing is estimated in its place.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="sf-tiles">
            <Tile label="NIFTY rollover" value={nr.available && nr.rollover_pct != null ? `${nr.rollover_pct.toFixed(1)}%` : MISSING} sub={nr.available ? `next-month share of open interest${nr.rollover_pct_at_open != null ? `, ${nr.rollover_pct_at_open.toFixed(1)}% at the open` : ""}` : nr.reason}
              tone="text-paper" />
            <Tile label="NIFTY roll cost" value={nr.available ? `${sgn(nr.roll_cost_pts, 1)} pts` : MISSING} sub={nr.available ? `${sgn(nr.roll_cost_pct, 2)}% next month over current` : undefined} />
            <Tile label="Stocks rollover" value={sf.rollover_pct == null ? MISSING : `${sf.rollover_pct.toFixed(1)}%`} sub={`by value over ${sf.rollover_stocks} stocks`} />
            <Tile label="Futures covered" value={`${sf.covered} of ${sf.of}`} sub="stocks with a live quote" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs" data-testid="sf-counts" aria-label="Buildup counts">
            {Object.keys(BUILDUP_TONE).map((k) => <span key={k} title={BUILDUP_HELP[k]} className={`rounded-full px-2.5 py-1 ${BUILDUP_TONE[k]}`}>{k} <b className="num">{counts[k] ?? 0}</b></span>)}
          </div>
          {bars && (
            <div className="mt-3">
              <div className="mb-1 text-xs text-muted">Open interest change since the first reading of the session, strongest falls and rises (green = long buildup or short covering, red = short buildup or long unwinding)</div>
              <div style={{ height: 40 + bars.n * 24 }}><EChart option={bars.option} ariaLabel="Open interest change of stock futures since the first reading" /></div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Sort stock futures">
            <span className="text-muted">Largest first by</span>
            {([["oi", "OI change"], ["price", "Price change"], ["rollover", "Rollover"]] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)} className={`min-h-8 rounded-full border px-3 ${sort === k ? "border-brass bg-brass/15 text-paper" : "border-rule text-muted hover:text-paper"}`}>{l}</button>
            ))}
          </div>
          <div className="mt-2 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[46rem] text-xs" data-testid="sf-table" aria-label="Stock futures">
              <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Stock</th><th className="py-1 text-right font-normal">Price</th><th className="py-1 text-right font-normal">Open interest</th><th className="py-1 text-right font-normal">OI change</th><th className="py-1 pl-3 font-normal">Buildup</th><th className="py-1 text-right font-normal">Basis</th><th className="py-1 text-right font-normal">Rollover</th><th className="py-1 text-right font-normal">Roll cost</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.symbol} className="num border-t border-rule/50" data-testid={`sf-row-${r.symbol}`}>
                  <td className="py-1.5 font-sans text-paper">{r.symbol}</td>
                  <td className={`py-1.5 text-right ${tone(r.price_change_pct)}`}>{r.ltp?.toLocaleString("en-IN") ?? MISSING} <span className="text-[10px]">{sgn(r.price_change_pct)}%</span></td>
                  <td className="py-1.5 text-right">{r.oi?.toLocaleString("en-IN") ?? MISSING}</td>
                  <td className={`py-1.5 text-right ${tone(r.oi_change)}`}>{r.oi_change == null ? MISSING : `${r.oi_change >= 0 ? "+" : "−"}${Math.abs(r.oi_change).toLocaleString("en-IN")}`} <span className="text-[10px]">{r.oi_change_pct == null ? "" : `${sgn(r.oi_change_pct, 1)}%`}</span></td>
                  <td className="py-1.5 pl-3 font-sans"><Chip label={r.buildup} /></td>
                  <td className="py-1.5 text-right">{r.basis_pct == null ? MISSING : `${sgn(r.basis_pct, 2)}%`}</td>
                  <td className="py-1.5 text-right">{r.rollover_pct == null ? MISSING : `${r.rollover_pct.toFixed(1)}%`}</td>
                  <td className="py-1.5 text-right">{r.roll_cost_pct == null ? MISSING : `${sgn(r.roll_cost_pct, 2)}%`}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <ul className="mt-2 space-y-2 md:hidden" data-testid="sf-cards" aria-label="Stock futures">
            {rows.map((r) => (
              <li key={r.symbol} className="rounded-lg border border-rule bg-ink/40 p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-base font-semibold text-paper">{r.symbol}</span><Chip label={r.buildup} /></div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div><dt className="text-muted">Price</dt><dd className={`num text-sm font-semibold ${tone(r.price_change_pct)}`}>{r.ltp?.toLocaleString("en-IN") ?? MISSING} ({sgn(r.price_change_pct)}%)</dd></div>
                  <div><dt className="text-muted">Open interest change</dt><dd className={`num text-sm font-semibold ${tone(r.oi_change)}`}>{r.oi_change_pct == null ? MISSING : `${sgn(r.oi_change_pct, 1)}%`}</dd></div>
                  <div><dt className="text-muted">Rollover to next month</dt><dd className="num text-sm font-semibold text-paper">{r.rollover_pct == null ? MISSING : `${r.rollover_pct.toFixed(1)}%`}</dd></div>
                  <div><dt className="text-muted">Futures over cash</dt><dd className="num text-sm font-semibold text-paper">{r.basis_pct == null ? MISSING : `${sgn(r.basis_pct, 2)}%`}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted" data-testid="sf-note">{sf.note} Buildup: price and open interest both up = long buildup; price down, open interest up = short buildup; price up, open interest down = short covering; both down = long unwinding. A label describes what changed, not who is long or short. {sf.tokens_note}</p>
    </section>
  );
}
