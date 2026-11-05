import { useQuery } from "@tanstack/react-query";
import { buildupRows, buildupSession, type Buildup } from "../lib/analytics";
import { api } from "../lib/api";
import { fmtPct, fmtTimeIST, MISSING } from "../lib/format";

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
const num = (v: number | null, d = 2) => (v == null ? MISSING : v.toLocaleString("en-IN", { maximumFractionDigits: d }));
const signed = (v: number | null, d = 0) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: d })}`);

/** NIFTY future: price against open interest, per 15 minutes and for the session so far (stored one-minute samples). */
export function FuturesBuildupBody() {
  const q = useQuery({ queryKey: ["futSeries", null], queryFn: () => api.futuresSeries(), refetchInterval: 30_000, retry: false });
  const s = q.data;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !s) return <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">The futures series could not be loaded: {q.error instanceof Error ? q.error.message : "unknown error"}.</p>;
  if (s.times.length === 0) return <p className="text-sm text-muted" data-testid="buildup-empty">{s.warnings[0] ?? "No futures samples are stored yet."}</p>;
  const all = buildupSession(s.times, s.future, s.oi);
  const rows = buildupRows(s.times, s.future, s.oi, 15);
  const last = s.times[s.times.length - 1]!;
  return (
    <div className="flex flex-col gap-3" data-testid="buildup-tool">
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <div className="text-xs text-muted">{s.contract ?? "NIFTY future"} · {s.day} · last stored sample {fmtTimeIST(last)} IST · {s.times.length} samples</div>
        {all && (
          <div className="mt-2 flex flex-wrap items-center gap-3" data-testid="buildup-session">
            <span className={`rounded-sm border px-2 py-0.5 text-sm font-semibold ${TONE[all.state]}`}>{all.state}</span>
            <span className="text-sm text-paper">Session so far: price {num(all.priceFrom)} → {num(all.priceTo)} ({signed(all.priceChg, 2)}, {fmtPct(all.priceChgPct)}), open interest {num(all.oiFrom, 0)} → {num(all.oiTo, 0)} ({signed(all.oiChg)}, {fmtPct(all.oiChgPct)})</span>
            <span className="text-xs text-muted">{MEANING[all.state]}</span>
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Every 15 minutes from the open</h2>
        <table className="w-full min-w-[40rem] text-xs" data-testid="buildup-table">
          <thead><tr className="text-left text-[11px] text-muted"><th className="py-1 font-normal">Window (IST)</th><th className="py-1 text-right font-normal">Price</th><th className="py-1 text-right font-normal">Price change</th><th className="py-1 text-right font-normal">Open interest</th><th className="py-1 text-right font-normal">OI change</th><th className="py-1 text-right font-normal">Reading</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.from} className="border-t border-rule/50">
                <td className="num py-1 text-paper">{fmtTimeIST(r.from)}–{fmtTimeIST(r.to)}</td>
                <td className="num py-1 text-right text-muted">{num(r.priceTo)}</td>
                <td className="num py-1 text-right text-paper">{signed(r.priceChg, 2)} <span className="text-muted">({fmtPct(r.priceChgPct)})</span></td>
                <td className="num py-1 text-right text-muted">{num(r.oiTo, 0)}</td>
                <td className="num py-1 text-right text-paper">{signed(r.oiChg)} <span className="text-muted">({fmtPct(r.oiChgPct)})</span></td>
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
