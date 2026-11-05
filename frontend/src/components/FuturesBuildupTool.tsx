import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { buildupRows, buildupSession, type Buildup, type BuildupRow } from "../lib/analytics";
import { api } from "../lib/api";
import { fmtPct, fmtTimeIST, MISSING } from "../lib/format";
import { EChart, useChartColors } from "./EChart";

const TONE: Record<Buildup, string> = {
  "long buildup": "border-up/50 text-up", "short covering": "border-up/30 text-up", "short buildup": "border-down/50 text-down",
  "long unwinding": "border-down/30 text-down", unchanged: "border-rule text-muted", missing: "border-rule text-muted",
};
const MEANING: Record<Buildup, string> = {
  "long buildup": "price up, open interest up: new longs are being added",
  "short buildup": "price down, open interest up: new shorts are being added",
  "short covering": "price up, open interest down: shorts are closing",
  "long unwinding": "price down, open interest down: longs are closing",
  unchanged: "price or open interest did not change", missing: "price or open interest was not recorded",
};
const FRAMES = [1, 3, 5, 15];
const num = (v: number | null, d = 2) => (v == null ? MISSING : v.toLocaleString("en-IN", { maximumFractionDigits: d }));
const signed = (v: number | null, d = 0) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: d })}`);
const btn = (on: boolean) => `min-h-9 rounded-sm border px-3 text-xs ${on ? "border-brass bg-brass/15 text-paper" : "border-rule bg-slate-2 text-muted hover:text-paper"}`;

/** Share of bullish windows (long buildup, short covering) among the bullish and bearish ones; windows with no reading are left out. */
export function sentimentOf(rows: BuildupRow[]): { counts: Record<Buildup, number>; bullPct: number | null; label: "Bullish" | "Bearish" | "Mixed" | null } {
  const counts: Record<Buildup, number> = { "long buildup": 0, "short covering": 0, "short buildup": 0, "long unwinding": 0, unchanged: 0, missing: 0 };
  rows.forEach((r) => { counts[r.state]++; });
  const bull = counts["long buildup"] + counts["short covering"];
  const bear = counts["short buildup"] + counts["long unwinding"];
  if (bull + bear === 0) return { counts, bullPct: null, label: null };
  const bullPct = (bull / (bull + bear)) * 100;
  return { counts, bullPct, label: bullPct >= 55 ? "Bullish" : bullPct <= 45 ? "Bearish" : "Mixed" };
}

/** NIFTY future: price against open interest per 1, 3, 5 or 15 minutes and for the session so far (stored one-minute samples). */
export function FuturesBuildupBody() {
  const c = useChartColors();
  const [tf, setTf] = useState(15);
  const [showPrice, setShowPrice] = useState(true);
  const [showOi, setShowOi] = useState(true);
  const q = useQuery({ queryKey: ["futSeries", null], queryFn: () => api.futuresSeries(), refetchInterval: 30_000, retry: false });
  const s = q.data;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !s) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The futures series could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  if (s.times.length === 0) return <p className="text-sm text-muted" data-testid="buildup-empty">{s.warnings[0] ?? "No futures samples are stored yet."}</p>;
  const all = buildupSession(s.times, s.future, s.oi);
  const rows = buildupRows(s.times, s.future, s.oi, tf);
  const sent = sentimentOf(rows);
  const last = s.times[s.times.length - 1]!;
  const stale = (Date.now() - Date.parse(last)) / 60000 > 5;
  const chart = {
    grid: { left: 52, right: 60, top: 14, bottom: 28 },
    tooltip: { trigger: "axis", confine: true, backgroundColor: c.slate, borderColor: c.rule, textStyle: { color: c.paper, fontSize: 12 } },
    xAxis: { type: "category", data: s.times.map((t) => fmtTimeIST(t)), axisLabel: { color: c.muted, hideOverlap: true }, axisLine: { lineStyle: { color: c.rule } } },
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.rule, opacity: 0.6 } } },
      { type: "value", scale: true, position: "right", axisLabel: { color: c.muted, formatter: (v: number) => `${(v / 1e7).toFixed(2)}Cr` }, splitLine: { show: false } },
    ],
    series: [
      ...(showPrice ? [{ name: "Future price", type: "line", showSymbol: false, connectNulls: false, data: s.future, lineStyle: { color: c.info, width: 1.8 }, itemStyle: { color: c.info } }] : []),
      ...(showOi ? [{ name: "Open interest", type: "line", yAxisIndex: 1, showSymbol: false, connectNulls: false, data: s.oi, lineStyle: { color: c.muted, width: 1.4, type: "dashed" }, itemStyle: { color: c.muted } }] : []),
    ],
  };
  return (
    <div className="flex flex-col gap-3" data-testid="buildup-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted" role="group" aria-label="Timeframe"><span className="mr-1">Timeframe</span>
          {FRAMES.map((m) => <button key={m} type="button" aria-pressed={tf === m} className={btn(tf === m)} onClick={() => setTf(m)}>{m} minute{m > 1 ? "s" : ""}</button>)}
        </div>
        <div className="mt-2 text-xs text-muted">{s.contract ?? "NIFTY future"} · {s.day} · last stored sample {fmtTimeIST(last)} IST · {s.times.length} samples</div>
        {stale && <p className="mt-1 text-xs text-warn" data-testid="buildup-stale">The newest sample is more than 5 minutes old: the feed or sampler may have stopped.</p>}
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm" data-testid="buildup-counts">
          {(["long buildup", "short covering", "short buildup", "long unwinding"] as Buildup[]).map((k) => (
            <span key={k} className="text-muted">{k[0]!.toUpperCase() + k.slice(1)}: <b className={TONE[k].split(" ")[1]}>{sent.counts[k]}</b></span>
          ))}
        </div>
        <div className="mt-2" data-testid="buildup-sentiment">
          <div className="flex justify-between text-[11px] text-muted">
            <span>{sent.bullPct == null ? MISSING : `${sent.bullPct.toFixed(0)}% bullish windows`}</span>
            <span>Windows: <b className="text-paper">{sent.label ?? "no reading"}</b></span>
            <span>{sent.bullPct == null ? MISSING : `${(100 - sent.bullPct).toFixed(0)}% bearish windows`}</span>
          </div>
          <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-rule" role="img" aria-label="Share of bullish and bearish windows">
            {sent.bullPct != null && <><div className="bg-up" style={{ width: `${sent.bullPct}%` }} /><div className="bg-down" style={{ width: `${100 - sent.bullPct}%` }} /></>}
          </div>
          <p className="mt-1 text-[11px] text-muted">Bullish = long buildup or short covering; bearish = short buildup or long unwinding; windows with no change or no reading are left out. Our reading: 55% or more bullish is Bullish, 45% or less Bearish. It counts this session&apos;s {tf}-minute windows, not a forecast.</p>
        </div>
        {all && (
          <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="buildup-session">
            <span className={`rounded-sm border px-2 py-0.5 text-sm font-semibold ${TONE[all.state]}`}>{all.state}</span>
            <span className="text-sm text-paper">Session so far: price {num(all.priceFrom)} → {num(all.priceTo)} ({signed(all.priceChg, 2)}, {fmtPct(all.priceChgPct)}), open interest {num(all.oiFrom, 0)} → {num(all.oiTo, 0)} ({signed(all.oiChg)}, {fmtPct(all.oiChgPct)})</span>
            <span className="text-xs text-muted">{MEANING[all.state]}</span>
          </div>
        )}
      </div>
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-paper">Future price vs open interest</h2>
          <button type="button" aria-pressed={showPrice} className={btn(showPrice)} onClick={() => setShowPrice((v) => !v)}>Price</button>
          <button type="button" aria-pressed={showOi} className={btn(showOi)} onClick={() => setShowOi((v) => !v)}>OI</button>
        </div>
        <div style={{ height: 320 }} data-testid="buildup-chart"><EChart option={chart} ariaLabel="NIFTY future price and open interest through the session" /></div>
        <p className="mt-1 text-[11px] text-muted">Solid: future price (left axis). Dashed: open interest in crore units (right axis). A gap is a minute where the value was not recorded.</p>
      </div>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Every {tf} minute{tf > 1 ? "s" : ""} from the open, newest first</h2>
        <table className="w-full min-w-[40rem] text-xs" data-testid="buildup-table">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window (IST)</th><th className="py-1 text-right font-normal">Price change</th><th className="py-1 text-right font-normal">Price</th><th className="py-1 text-right font-normal">OI change</th><th className="py-1 text-right font-normal">Open interest</th><th className="py-1 text-right font-normal">Reading</th></tr></thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.from} className="border-t border-rule/50">
                <td className="num py-1 text-paper">{tf === 1 ? fmtTimeIST(r.to) : `${fmtTimeIST(r.from)}–${fmtTimeIST(r.to)}`}</td>
                <td className={`num py-1 text-right ${r.priceChg == null ? "text-muted" : r.priceChg >= 0 ? "text-up" : "text-down"}`}>{signed(r.priceChg, 2)} <span className="text-muted">({fmtPct(r.priceChgPct)})</span></td>
                <td className="num py-1 text-right text-paper">{num(r.priceTo)}</td>
                <td className={`num py-1 text-right ${r.oiChg == null ? "text-muted" : r.oiChg >= 0 ? "text-up" : "text-down"}`}>{signed(r.oiChg)} <span className="text-muted">({fmtPct(r.oiChgPct)})</span></td>
                <td className="num py-1 text-right text-muted">{num(r.oiTo, 0)}</td>
                <td className="py-1 text-right"><span className={`rounded-sm border px-1.5 py-px text-[11px] ${TONE[r.state]}`}>{r.state}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-muted">Rule: price up and OI up = long buildup; price down and OI up = short buildup; price up and OI down = short covering; price down and OI down = long unwinding. Each window starts from the last recorded value before it; a value that was not recorded is shown as {MISSING}, never filled. A reading describes one window only, not a forecast.</p>
        {s.warnings.map((w) => <p key={w} className="mt-1 text-[11px] text-warn">{w}</p>)}
      </div>
    </div>
  );
}
