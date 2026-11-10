R = r"C:\Users\SATISH~1\AppData\Local\Temp\claude\S--Nseuniverse\fd06f634-3462-470d-ac50-67680b70a03e\scratchpad\repo_main\frontend\src"

# ---------------- types
p = R + r"\lib\types.ts"
s = open(p, encoding="utf-8").read()
s = s.replace("  difference?: { diff: number | null; ci95: [number, number] | null; mean_event: number | null; mean_other: number | null };\n}", "  difference?: { diff: number | null; ci95: [number, number] | null; mean_event: number | null; mean_other: number | null };\n  correlation?: { r: number; n: number; ci95: [number, number] | null } | null;\n}", 1)
old = s[s.index("export interface Backtest {"):s.index("}\n", s.index("export interface Backtest {")) + 2]
s = s.replace(old, '''export interface Backtest {
  status: string; expiry: string; universe?: "fixed" | "dynamic" | "full"; sessions: string[]; snapshots: number; horizon_minutes: number; oos_share: number; min_events: number; cost_bps: number;
  tests: BacktestResult[]; not_testable: { id: string; title: string; reason: string }[]; note: string; message?: string;
  progress?: { done: number; total: number; uncached?: number };
  reconstruction?: { snapshots_with: Record<string, number>; snapshots_skipped: Record<string, number>; opening_atm: Record<string, number | null> };
  timing?: Record<string, number>;
}
export interface GexHistoryPoint { at: string; spot: number; ce: number | null; pe: number | null; net: number | null; abs: number | null; flip: number | null; near_net: number | null; call_wall: number | null; put_wall: number | null; peak: number | null; used: number | null }
export interface GexHistory {
  status: string; expiry: string; session?: string; universe: "fixed" | "dynamic" | "full"; sessions?: string[]; opening_atm?: number | null;
  points: GexHistoryPoint[]; skipped?: { at: string; reason: string }[]; timing?: Record<string, number>; units?: string;
}
''', 1)
open(p, "w", encoding="utf-8").write(s)

# ---------------- api
p = R + r"\lib\api.ts"
s = open(p, encoding="utf-8").read()
import re
s = re.sub(r"  intradayBacktest: \(expiry: string, sessions = 15, cost = 5\) => request<import\(\"./types\"\).Backtest>\(`[^`]*`\),",
           "  intradayBacktest: (expiry: string, sessions = 15, cost = 5, universe = \"dynamic\") => request<import(\"./types\").Backtest>(`/api/intraday/backtest?expiry=${encodeURIComponent(expiry)}&sessions=${sessions}&cost_bps=${cost}&universe=${universe}`),\n  intradayGexHistory: (expiry: string, universe = \"dynamic\", session?: string) => request<import(\"./types\").GexHistory>(`/api/intraday/gex-history?expiry=${encodeURIComponent(expiry)}&universe=${universe}${session ? `&session=${session}` : \"\"}`),", s, count=1)
open(p, "w", encoding="utf-8").write(s)

# ---------------- registry
p = R + r"\lib\metricRegistry.ts"
s = open(p, encoding="utf-8").read().rstrip()
assert s.endswith("};")
s = s.replace('''      "Split: sessions in date order; the earliest 60 % are in-sample (description only), the latest 40 % are out-of-sample (the result)",''', '''      "GEX tests (one universe throughout: fixed, dynamic or full, chosen on the page): net GEX ÷ absolute GEX vs the next-30-minute realised volatility (Pearson r with a Fisher-z 95 % interval); net GEX < 0 vs ≥ 0 vs realised volatility; spot crossing the gamma flip between consecutive snapshots → continuation over the next 30 min; flip migrating ≥ 0.1 % of spot in 15 min → same-direction return; GEX-price divergence (spot ±0.05 % and net GEX ±5 % of the larger |net| over 15 min) → continuation (amplifying) or fade (stabilising)",
      "Split: sessions in date order; the earliest 60 % are in-sample (description only), the latest 40 % are out-of-sample (the result)",''', 1)
s = s.replace('"Gamma-flip, GEX and term-slope tests are not run because their history is not stored server-side."', '"GEX history is rebuilt from the stored chains at each snapshot (not stored separately); a snapshot whose chain cannot be solved is skipped and counted. The term-slope test is not run (needs several expiries sampled together)."', 1)
s = s[:-2] + '''  gex_reconstruction: {
    id: "gex_reconstruction", version: "1", title: "Historical GEX and gamma-flip reconstruction",
    measures: "The GEX, gamma flip, walls, peak and near-ATM GEX the gamma page would have shown at each stored snapshot, rebuilt from that snapshot's own prices and open interest.",
    formula: [
      "GEX_strike = gamma × OI × Spot² × 0.01 / 10⁷  (₹ crore per 1 % move, OI in units); call +, put −; net = call + put, absolute = call + |put| over strikes with both sides",
      "gamma (per unit of spot) = e^(−r t) φ(d1) q / (Spot σ √t), q = forward ÷ spot from put-call parity at that snapshot, σ = the contract's own solved IV, d1 = (ln(Spot q / K) + σ² t / 2) / (σ √t)",
      "Gamma flip: net GEX re-priced at 33 spot levels within ±8 % and refined by bisection; the crossing nearest spot, none if the sign never changes",
      "Universes: fixed = ATM ± 10 strikes of the session's first snapshot; dynamic = ATM ± 10 around that snapshot's spot; full = every listed strike. Near-ATM = ATM ± 5 strikes of the universe",
    ],
    computedBy: { backend: "reconstruct / levels / gamma_flip (app/intraday/gex_history.py); the browser's gammaAnalysis.ts is the same calculation" },
    unit: "₹ crore per 1 % move; levels in index points", sign: "Calls positive, puts negative: a model assumption, not observed dealer inventory.",
    inputs: [{ name: "premium, OI", source: "stored option-chain sample (last traded price and open interest per contract)", unit: "₹, units", kind: "raw" }, { name: "σ, q, t", source: "Black-76 solved at that snapshot; time to the expiry close", unit: "per year, ratio, years", kind: "derived" }],
    steps: ["Take the last sample of each 5-minute bucket.", "Solve every contract's IV and the forward.", "Compute each strike's call and put exposure, then totals, walls, peak, near-ATM and flip per universe.", "A contract without a solved IV or OI is counted as missing, never as zero; a snapshot that cannot be solved is skipped and listed."],
    reading: { positive: "Net GEX positive under the model sign: stabilising tendency.", negative: "Net GEX negative: amplifying tendency.", rising: "Shifting to the stabilising side.", falling: "Shifting to the amplifying side.", nearZero: "Call and put exposure roughly offset; the flip is near." },
    assumptions: ["Only data available at the snapshot is used; the history is never back-filled or smoothed.", "The reconstruction uses one expiry at a time, as the gamma page does.", "Open interest in the stored chain is the broker's value at that time and can lag; stale quotes are not filtered beyond the solve rules."],
  },
};
'''
open(p, "w", encoding="utf-8").write(s)

# ---------------- component
p = R + r"\components\SignalBacktest.tsx"
s = open(p, encoding="utf-8").read()
s = s.replace('import { MethodologyPanel } from "./MethodologyPanel";', 'import { GexHistoryChart } from "./GexHistoryChart";\nimport { MethodologyPanel } from "./MethodologyPanel";', 1)
# correlation rows
s = s.replace('''function Side({ s, directional }: { s: BacktestSide; directional: boolean }) {
  return (
    <>''', '''function Side({ s, directional }: { s: BacktestSide; directional: boolean }) {
  if (s.correlation !== undefined) {
    return (
      <>
        <td className="num px-2 py-1.5 text-right">{s.events}</td><td className="px-2 py-1.5 text-right text-muted">—</td>
        <td className="num px-2 py-1.5 text-right" title="Pearson correlation of net GEX / absolute GEX with the next-30-minute realised volatility">{s.correlation ? `r = ${s.correlation.r.toFixed(3)}` : MISSING}</td>
        <td className="num px-2 py-1.5 text-right text-muted">{s.correlation ? ci(s.correlation.ci95, 3) : MISSING}</td><td className="px-2 py-1.5 text-right text-muted">—</td><td className="px-2 py-1.5 text-right text-muted">—</td>
      </>
    );
  }
  return (
    <>''', 1)
# state, query with polling, universe
s = s.replace('''  const [cost, setCost] = useState(5);
  const q = useQuery({ queryKey: ["backtest", expiry, sessions, cost], queryFn: () => api.intradayBacktest(expiry!, sessions, cost), enabled: !!expiry, staleTime: 120_000, retry: false });''', '''  const [cost, setCost] = useState(5);
  const [universe, setUniverse] = useState<"fixed" | "dynamic" | "full">("dynamic");
  const q = useQuery({
    queryKey: ["backtest", expiry, sessions, cost, universe], queryFn: () => api.intradayBacktest(expiry!, sessions, cost, universe), enabled: !!expiry, staleTime: 120_000, retry: false,
    refetchInterval: (query) => (query.state.data?.status === "computing" ? 1500 : false), // a large run reports progress until it is done
  });''', 1)
s = s.replace('''  const d = q.data;
  const th =''', '''  const d = q.data;
  if (d.status === "computing" || d.status === "busy") {
    const p = d.progress;
    const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    return (
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 text-sm" data-testid="bt-progress" role="status">
        {d.status === "busy" ? <p className="text-warn">{d.message}</p> : <p className="text-paper">Rebuilding the stored chains of {sessions} sessions (volatility, GEX and flip at each 5-minute snapshot): {p ? `${p.done} of ${p.total} snapshots, ${pct}%` : "starting"}.</p>}
        <div className="mt-2 h-2 w-full max-w-md rounded-sm bg-slate-2"><div className="h-2 rounded-sm bg-brass" style={{ width: `${pct}%` }} /></div>
        <p className="mt-2 text-xs text-muted">This runs once on the server and is then reused: a repeat request, or a different cost or universe, answers from the saved features. Only one large run executes at a time.</p>
      </div>
    );
  }
  const th =''', 1)
s = s.replace('''          <label className="flex items-center gap-1">Round-trip cost''', '''          <label className="flex items-center gap-1">GEX universe<select aria-label="GEX universe" value={universe} onChange={(e) => setUniverse(e.target.value as typeof universe)} className="min-h-8 rounded-sm border border-rule bg-slate-2 px-1 text-paper"><option value="fixed">Fixed opening ATM ±10</option><option value="dynamic">Dynamic ATM ±10</option><option value="full">Full chain</option></select></label>
          <label className="flex items-center gap-1">Round-trip cost''', 1)
# reconstruction report + history chart before the not-testable block
s = s.replace('''      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Not testable with the data stored today</h2>''', '''      {d.reconstruction && (
        <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3" data-testid="bt-recon">
          <h2 className="mb-1 text-sm font-semibold text-paper">Reconstruction and missing data ({d.universe} universe)</h2>
          <p className="text-xs text-muted">{d.snapshots} snapshots solved. Snapshots with each GEX metric: {Object.entries(d.reconstruction.snapshots_with).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(" · ")}. A level missing at a snapshot (for example no gamma flip within ±8 %, or no put wall because every strike is above spot) stays missing and is not carried forward.</p>
          {Object.keys(d.reconstruction.snapshots_skipped).length > 0 && <p className="mt-1 text-xs text-warn" data-testid="bt-skipped">Snapshots skipped: {Object.entries(d.reconstruction.snapshots_skipped).map(([k, v]) => `${v} (${k})`).join("; ")}.</p>}
          {d.timing && <p className="mt-1 text-[11px] text-muted">Server work: {Math.round(d.timing.total_ms ?? 0)} ms · {d.timing.computed ?? 0} snapshots computed, {d.timing.cached ?? 0} reused.</p>}
        </div>
      )}
      {expiry && <GexHistoryChart expiry={expiry} universe={universe} />}
      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">
        <h2 className="mb-1 text-sm font-semibold text-paper">Not testable with the data stored today</h2>''', 1)
s = s.replace("<MethodologyPanel metrics={[METRICS.backtest_construction!, METRICS.backtest_metrics!]}", "<MethodologyPanel metrics={[METRICS.backtest_construction!, METRICS.backtest_metrics!, METRICS.gex_reconstruction!]}", 1)
open(p, "w", encoding="utf-8").write(s)
print("ok")
