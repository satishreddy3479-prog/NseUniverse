import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { GammaMapPanel } from "../components/risk/GammaMapPanel";
import { GreeksDashboard } from "../components/risk/GreeksDashboard";
import { AdvancedPanels } from "../components/risk/AdvancedPanels";
import { explainRisk as explain } from "../components/risk/BuilderWhatIf";
import { SurfaceViewer } from "../components/risk/SurfaceViewer";
import { api } from "../lib/api";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { buildPosition } from "../lib/builderPosition";
import { useLiveFutureContracts, futurePrice } from "../lib/futures";
import { useExpiries } from "../lib/hooks";
import { marketClockMs } from "../lib/session";
import type { PLeg } from "../lib/advancedGreeks";
import { legsFromBuilder, riskApi, RiskApiError, stampText } from "../lib/risk";

/** The live view is a poll: the surface is rebuilt on the server only when quotes changed, so asking often is cheap. */
const POLL = { portfolio: 1_000, surface: 5_000 } as const;

/** Advanced Greeks: the position's Greeks in rupees by leg, expiry and portfolio limits, the gamma map and the volatility surface it is valued on. The what-if scenarios (index, volatility, time and rate moves, the risk matrix and the payoff) live in the Strategy Builder's Scenarios tab, on the strategy being built. Read-only: nothing is sent to a broker. */
export function AdvancedGreeks() {
  const status = useQuery({ queryKey: ["risk-status"], queryFn: riskApi.status, refetchInterval: 30_000, retry: false });
  const builder = useQuery({ queryKey: ["risk-builder"], queryFn: api.runningGet, refetchInterval: 30_000, retry: false });
  const builderLegs = useMemo(() => legsFromBuilder(builder.data?.doc?.legs), [builder.data]);
  const legs = builderLegs;
  const has = legs.length > 0;
  const key = useMemo(() => JSON.stringify(legs), [legs]);
  const doc = builder.data?.doc ?? null;
  const ex = useExpiries();
  const collected = useMemo(() => new Set([ex.data?.weekly, ex.data?.monthly].filter((e): e is string => !!e)), [ex.data]);
  const legExpiries = useMemo(() => [...new Set((doc?.legs ?? []).filter((l) => l.enabled !== false && l.exitPrice == null).map((l) => l.expiry))].sort(), [doc]);
  const chainQs = useQueries({ queries: legExpiries.map((e) => ({ queryKey: ["adv-chain", e], queryFn: () => (collected.has(e) ? api.optionChain(e) : api.optionChainOnDemand(e)), retry: false, staleTime: 5_000, refetchInterval: 15_000 })) });
  const chainKey = chainQs.map((q) => q.data?.snapshot.snapshot_id ?? "").join("|");
  const futs = useLiveFutureContracts();
  const ivChart = useQuery({ queryKey: ["adv-closes"], queryFn: () => api.intradayIvChart(20), retry: false, staleTime: 300_000 });
  const bars = useQuery({ queryKey: ["indexBars"], queryFn: () => api.indexBars(), retry: false, refetchInterval: 60_000 });
  const closes = useMemo(() => (ivChart.data ? ivChart.data.dates.map((d, i) => ({ day: d, close: ivChart.data!.close[i]! })).filter((x) => Number.isFinite(x.close)) : null), [ivChart.data]);
  const first = chainQs.find((q) => q.data)?.data?.snapshot;
  const nowMs = first ? marketClockMs(Date.parse(first.retrieved_at)) : Date.now();
  const lotSize = first?.lot_size ?? doc?.lotSize ?? null;
  const rate = 0.06;
  const pos = useMemo(() => buildPosition(doc?.legs, chainQs.flatMap((q, i) => (q.data ? [{ expiry: legExpiries[i]!, rows: q.data.snapshot.rows, spot: q.data.snapshot.underlying_ltp }] : [])), nowMs, rate, lotSize, doc?.mult ?? 1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, chainKey, nowMs, lotSize]);
  const rowsBy = useMemo(() => Object.fromEntries(chainQs.flatMap((q, i) => (q.data ? [[legExpiries[i]!, q.data.snapshot.rows]] : []))), [chainKey, legExpiries]); // eslint-disable-line react-hooks/exhaustive-deps
  const entryLevel = useCallback((l: PLeg) => {
    if (!l.enteredAt || !bars.data?.bars.length) return null;
    const t = Date.parse(l.enteredAt);
    let best: { at: string; c: number } | null = null, bd = Infinity;
    for (const b of bars.data.bars) { const d = Math.abs(Date.parse(b.at) - t); if (d < bd) { bd = d; best = b; } }
    return best && bd <= 180_000 ? { spot: best.c, ms: t } : null;
  }, [bars.data]);
  const nowPrice = useCallback((l: PLeg) => {
    if (l.type === "FUT") return futurePrice(futs, l.expiry);
    const row = rowsBy[l.expiry]?.find((r) => r.strike === l.strike);
    const q = l.type === "CE" ? row?.call : row?.put;
    return q?.ltp != null && q.ltp > 0 ? q.ltp : null;
  }, [futs, rowsBy]);
  const builderFutures = useMemo(() => (builder.data?.doc?.legs ?? []).filter((l) => l.enabled !== false && l.type === "FUT").length, [builder.data]);

  const surface = useQuery({ queryKey: ["risk-surface"], queryFn: () => riskApi.surface(), refetchInterval: POLL.surface, retry: false, placeholderData: keepPreviousData });
  const expiries = useMemo(() => Array.from(new Set([...(surface.data?.slices.map((s) => s.expiry) ?? []), ...legs.map((l) => l.expiry)])).filter(Boolean).sort(), [surface.data, legs]);
  const opt = { enabled: has, retry: false, placeholderData: keepPreviousData } as const;
  const portfolio = useQuery({ queryKey: ["risk-portfolio", key], queryFn: () => riskApi.portfolio(legs), refetchInterval: POLL.portfolio, ...opt });

  const stamp = portfolio.data ?? surface.data ?? null;
  const degraded = (surface.data?.slices ?? []).filter((s) => s.degraded);
  const gone = status.data?.enabled === false || (status.error instanceof RiskApiError && status.error.code === "disabled");

  return (
    <div className="stagger mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="greeks-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted"><Link to="/" className="text-info hover:underline">← All tools</Link></p>
          <h1 className="text-xl font-semibold md:text-2xl">Advanced Greeks</h1>
          <p className="text-xs text-muted">The risk views of the strategy in the <Link to="/strategy" className="text-info hover:underline">Strategy Builder</Link> (its open, ticked legs, futures included): ladders, delta hedge, gamma against theta, higher-order Greeks, vega by smile factor, P&L by Greek, smile analytics, value at risk and stress. Below them the engine's rupee Greeks, the gamma map and the volatility surface. What-if scenarios are on the Builder's Scenarios tab. Read-only: nothing is placed or sent to a broker.</p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-3">
          <ChartInfoToggle />
          <div className="text-right text-xs" data-testid="risk-stamp">
            <div className="font-medium text-paper" title={stamp?.surface_version_id ?? ""} data-testid="risk-stamp-text">{stampText(stamp)}</div>
            {stamp && <div className={stamp.stale || stamp.source === "stored" ? "text-warn" : "text-up"}>{stamp.source === "live" ? "Live books in use" : "Stored chain"}{stamp.stale ? " · stale" : ""}</div>}
          </div>
        </div>
      </header>
      {gone ? (
        <p role="alert" className="rounded-sm border border-rule bg-slate p-3 text-sm text-muted" data-testid="risk-disabled">The Greeks engine is turned off on this server.</p>
      ) : (
        <>
          {status.data?.config_error && <p role="alert" className="rounded-sm border border-down/50 bg-down/10 p-2 text-sm text-down" data-testid="risk-config-error">The engine's configuration needs fixing: {status.data.config_error}</p>}
          {degraded.length > 0 && <p className="rounded-sm border border-warn/50 bg-warn/10 px-2 py-1 text-xs text-warn" data-testid="risk-degraded-banner">Model degraded for {degraded.map((s) => s.expiry).join(", ")}: {degraded[0]!.degraded_reason}. Figures for these expiries are unavailable or less reliable; see the surface below.</p>}
          {builderFutures > 0 && <p role="note" className="px-1 text-xs text-warn" data-testid="greeks-futures-note">The Strategy Builder holds {builderFutures} NIFTY future leg{builderFutures === 1 ? "" : "s"}. The panels above include it; the engine's Greeks, gamma map and surface below price options only and leave it out.</p>}
          <AdvancedPanels pos={pos} nowMs={nowMs} rate={rate} lotSize={lotSize} rows={rowsBy} closes={closes} entryLevel={entryLevel} nowPrice={nowPrice} />
          <GreeksDashboard risk={portfolio.data?.portfolio} version={portfolio.data?.surface_version_id ?? null} asOf={stampText(portfolio.data ?? null).replace(/, surface .*/, "")} busy={portfolio.isFetching} error={has ? explain(portfolio.error) : null} />
          <GammaMapPanel expiries={expiries} />
          <SurfaceViewer surface={surface.data} busy={surface.isFetching} error={explain(surface.error)} />
        </>
      )}
    </div>
  );
}
