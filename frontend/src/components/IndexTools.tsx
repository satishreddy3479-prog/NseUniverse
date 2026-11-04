import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, ApiError, type MarketSectorRow, type MarketStockRow, type MarketSummary } from "../lib/api";
import { fmtTimeIST } from "../lib/format";
import { EChart, useChartColors } from "./EChart";
import { Panel } from "./ui";
import type { ChartColors } from "../lib/chartOptions";

const pct = (v: number | null, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null) => (v == null || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");

/** Horizontal bars, one per name, coloured by sign. Values stay null-skipped, never zero-filled. */
export function barsOption(rows: { name: string; value: number }[], unit: string, c: ChartColors) {
  const r = [...rows].reverse();
  return {
    animation: false, grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${v.toFixed(3)} ${unit}` },
    xAxis: { type: "value", axisLabel: { color: c.muted, fontSize: 11 }, splitLine: { lineStyle: { color: c.rule } } },
    yAxis: { type: "category", data: r.map((x) => x.name), axisLabel: { color: c.muted, fontSize: 11 } },
    series: [{ type: "bar", data: r.map((x) => ({ value: x.value, itemStyle: { color: x.value >= 0 ? c.up : c.down } })) }],
  };
}

function useSummary() {
  return useQuery({ queryKey: ["market-summary"], queryFn: api.marketSummary, refetchInterval: 15_000, retry: false });
}

function Guard({ q, children }: { q: ReturnType<typeof useSummary>; children: (s: MarketSummary) => React.ReactNode }) {
  if (q.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (q.error) {
    const off = q.error instanceof ApiError && q.error.status === 404;
    return <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-warn">{off ? "Stock breadth is turned off on this server, so there is nothing to show." : q.error instanceof ApiError ? q.error.message : "Could not load the NIFTY 50 stock data."}</p>;
  }
  return <>{children(q.data)}</>;
}

function Source({ s }: { s: MarketSummary }) {
  const w = s.nifty50.weights;
  return (
    <p className="text-xs text-muted">
      Prices from the live feed at {fmtTimeIST(s.generated_at)} IST · {s.nifty50.breadth.covered} of {s.nifty50.breadth.total} stocks have a current price
      {w ? ` · weights ${w.approximate ? "approximated" : "official"}, as of ${w.as_of}${w.rolled_to ? ` (rolled to ${w.rolled_to} closes)` : ""}, source ${w.source}` : " · no weights loaded"}
    </p>
  );
}

function Contributors({ s }: { s: MarketSummary }) {
  const c = useChartColors();
  const rows = useMemo(() => s.nifty50.stocks.filter((x) => x.contribution != null).sort((a, b) => (b.contribution as number) - (a.contribution as number)), [s]);
  const shown = [...rows.slice(0, 10), ...rows.slice(-10)].filter((x, i, a) => a.findIndex((y) => y.symbol === x.symbol) === i);
  const ct = s.nifty50.contribution;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <span>Index change <b className={tone(s.index_change_pct)}>{pct(s.index_change_pct)}</b></span>
        <span>Sum of contributions <b className={tone(ct?.net_points_pct ?? null)}>{pct(ct?.net_points_pct ?? null, 3)}</b></span>
        <span>Top 5 share <b>{ct?.top5_share == null ? "—" : `${(ct.top5_share * 100).toFixed(0)}%`}</b></span>
        <span>Weight covered <b>{ct ? `${ct.weight_covered.toFixed(1)}%` : "—"}</b></span>
      </div>
      {shown.length === 0 ? <p className="text-sm text-muted">No stock has both a weight and a current price yet.</p> : (
        <div className="h-[460px]"><EChart ariaLabel="NIFTY 50 contribution by stock" option={barsOption(shown.map((x) => ({ name: x.symbol, value: x.contribution as number })), "% of index", c)} /></div>
      )}
      <p className="text-xs text-muted">Contribution = weight × the stock's change since its previous close, in percentage points of the index (a stock with weight 10 % and +1 % adds 0.10). The ten largest positive and negative are shown.</p>
      <Source s={s} />
    </div>
  );
}

function Breadth({ s }: { s: MarketSummary }) {
  const b = s.nifty50.breadth;
  const cell = (label: string, v: string, cls = "text-paper") => <div className="rounded-sm border border-rule bg-slate-2 px-3 py-2"><div className="text-xs text-muted">{label}</div><div className={`num text-lg font-semibold ${cls}`}>{v}</div></div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {cell("Advancing", String(b.advancing), "text-up")}{cell("Declining", String(b.declining), "text-down")}{cell("Unchanged", String(b.flat))}
        {cell("Advance / decline", b.ad_ratio == null ? "—" : b.ad_ratio.toFixed(2))}{cell("% advancing", b.pct_advancing == null ? "—" : `${b.pct_advancing.toFixed(0)}%`)}{cell("Equal-weight return", pct(b.equal_weight_return), tone(b.equal_weight_return))}
      </div>
      <div className="flex h-5 overflow-hidden rounded-sm border border-rule" role="img" aria-label={`${b.advancing} advancing, ${b.declining} declining, ${b.flat} unchanged`}>
        <div style={{ flex: b.advancing }} className="bg-up" /><div style={{ flex: b.flat }} className="bg-muted/50" /><div style={{ flex: b.declining }} className="bg-down" />
      </div>
      <p className="text-xs text-muted">Trading at today's high: {b.at_high} stocks; at today's low: {b.at_low}. A stock counts as advancing or declining against its previous close.</p>
      <Source s={s} />
    </div>
  );
}

function Weightage({ s }: { s: MarketSummary }) {
  const rows = [...s.nifty50.stocks].filter((x) => x.weight != null).sort((a, b) => (b.weight as number) - (a.weight as number));
  const total = rows.reduce((t, x) => t + (x.weight as number), 0);
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? <p className="text-sm text-muted">No weights are loaded on this server, so none are shown.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm" aria-label="NIFTY 50 weights">
          <thead className="text-xs text-muted"><tr><th className="py-1 text-left font-normal">#</th><th className="text-left font-normal">Stock</th><th className="text-left font-normal">Sector</th><th className="text-right font-normal">Weight %</th><th className="text-right font-normal">Change</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.symbol} className="border-t border-rule/50"><td className="py-1 text-muted">{i + 1}</td><td className="font-medium">{r.symbol}</td><td className="text-muted">{r.sector ?? "—"}</td>
              <td className="num text-right">{(r.weight as number).toFixed(2)}</td><td className={`num text-right ${tone(r.change_pct)}`}>{pct(r.change_pct)}</td></tr>))}</tbody>
          <tfoot><tr className="border-t border-rule text-muted"><td colSpan={3} className="py-1">Total of {rows.length} stocks</td><td className="num text-right">{total.toFixed(2)}</td><td /></tr></tfoot>
        </table></div>
      )}
      <Source s={s} />
    </div>
  );
}

function Sectors({ s }: { s: MarketSummary }) {
  const c = useChartColors();
  const rows: MarketSectorRow[] = [...s.sectors.nifty50].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const bars = rows.filter((r) => r.relative_strength != null).map((r) => ({ name: r.sector, value: r.relative_strength as number }));
  return (
    <div className="flex flex-col gap-3">
      {bars.length > 0 && <div className="h-[360px]"><EChart ariaLabel="Sector relative strength" option={barsOption(bars, "% vs index", c)} /></div>}
      <div className="overflow-x-auto"><table className="w-full text-sm" aria-label="Sectors inside NIFTY 50">
        <thead className="text-xs text-muted"><tr><th className="py-1 text-left font-normal">Rank</th><th className="text-left font-normal">Sector</th><th className="text-right font-normal">Stocks</th><th className="text-right font-normal">Up / down</th><th className="text-right font-normal">Return (equal wt)</th><th className="text-right font-normal">vs index</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.sector} className="border-t border-rule/50"><td className="py-1 text-muted">{r.rank ?? "—"}</td><td className="font-medium">{r.sector}</td><td className="num text-right">{r.covered}/{r.stocks}</td>
            <td className="num text-right"><span className="text-up">{r.advancing}</span> / <span className="text-down">{r.declining}</span></td>
            <td className={`num text-right ${tone(r.equal_weight_return)}`}>{pct(r.equal_weight_return)}</td><td className={`num text-right ${tone(r.relative_strength)}`}>{pct(r.relative_strength)}</td></tr>))}</tbody>
      </table></div>
      <p className="text-xs text-muted">Relative strength = the sector's return minus the NIFTY 50's return today. Sector memberships come from the NIFTY 50 list stored on this server.</p>
      <Source s={s} />
    </div>
  );
}

function Movers({ s }: { s: MarketSummary }) {
  const withMove = s.nifty50.stocks.filter((x): x is MarketStockRow & { change_pct: number } => x.change_pct != null).sort((a, b) => b.change_pct - a.change_pct);
  const list = (title: string, rows: typeof withMove) => (
    <Panel title={title}><table className="w-full text-sm"><tbody>{rows.map((r) => (
      <tr key={r.symbol} className="border-t border-rule/50 first:border-0"><td className="py-1 font-medium">{r.symbol}</td><td className="text-muted">{r.sector ?? ""}</td>
        <td className={`num text-right ${tone(r.change_pct)}`}>{pct(r.change_pct)}</td><td className="num text-right text-muted">{r.relative_volume == null ? "" : `${r.relative_volume.toFixed(1)}× vol`}</td></tr>))}</tbody></table></Panel>
  );
  return (
    <div className="flex flex-col gap-3">
      {withMove.length === 0 ? <p className="text-sm text-muted">No stock has a current price yet.</p> : (
        <div className="grid gap-3 md:grid-cols-2">{list("Top gainers", withMove.slice(0, 10))}{list("Top losers", [...withMove].reverse().slice(0, 10))}</div>
      )}
      <p className="text-xs text-muted">NIFTY 50 stocks only. Relative volume compares volume so far with the stock's recent average for this time of day, when enough sessions are stored.</p>
      <Source s={s} />
    </div>
  );
}

export function IndexToolBody({ page }: { page: "contributors" | "weightage" | "breadth" | "sectors" | "movers" }) {
  const q = useSummary();
  return <Guard q={q}>{(s) => (page === "contributors" ? <Contributors s={s} /> : page === "breadth" ? <Breadth s={s} /> : page === "weightage" ? <Weightage s={s} /> : page === "sectors" ? <Sectors s={s} /> : <Movers s={s} />)}</Guard>;
}
