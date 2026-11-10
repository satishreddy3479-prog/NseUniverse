R = r"C:\Users\SATISH~1\AppData\Local\Temp\claude\S--Nseuniverse\fd06f634-3462-470d-ac50-67680b70a03e\scratchpad\repo_main\frontend\src"
p = R + r"\components\MarketStructure.tsx"
s = open(p, encoding="utf-8").read()

s = s.replace('import { gexUniverses } from "../lib/gexIntel";', 'import { gexPriceDivergence, gexUniverses } from "../lib/gexIntel";', 1)
s = s.replace('import { fmtCrore } from "../lib/gammaAnalysis";', 'import { fmtCrore, type StructurePoint } from "../lib/gammaAnalysis";', 1)
s = s.replace('''  const chart = useQuery({ queryKey: ["ivchart", 21],''', '''  // GEX inputs of the regime come from ONE universe (the dynamic ATM ±10 rebuild of the stored chains), the same series for the level, the
  // change, the flip, the near-ATM figure and the GEX-price relationship
  const gexh = useQuery({ queryKey: ["gexHistory", expiry, "dynamic"], queryFn: () => api.intradayGexHistory(expiry!, "dynamic"), ...on });
  const chart = useQuery({ queryKey: ["ivchart", 21],''', 1)

s = s.replace('''  const atmChg =''', '''  const gh = gexh.data?.status === "ok" && Array.isArray(gexh.data.points) ? gexh.data.points : [];
  const ghPts: StructurePoint[] = gh.map((p) => ({ t: Date.parse(p.at), spot: p.spot, net: p.net, peak: p.peak, callWall: p.call_wall, putWall: p.put_wall, flip: p.flip, roc: null }));
  const div = ghPts.length >= 2 ? gexPriceDivergence(ghPts, 15) : null;
  const ghLast = gh[gh.length - 1] ?? null;
  const atmChg =''', 1)

old = s[s.index("    spotPct: m15?.spot_change_pct ?? null,"):s.index("  const r: RegimeResult")]
new = '''    spotPct: m15?.spot_change_pct ?? null, atmIvChange: atmChg, momentum25: m15?.d25.momentum ?? null,
    skew25: sk?.cards?.skew_25d ?? null, butterfly25: sk?.cards?.butterfly_25d ?? null, ivMinusHv: iv != null && hv != null ? iv - hv : null,
    demand: demandMap, netGex: ghLast?.net ?? null, flip: ghLast?.flip ?? null, spot: ghLast?.spot ?? dash?.snapshot?.underlying_ltp ?? sk?.spot ?? null,
    divergence: div?.kind ?? null, divergenceLabel: div?.label ?? null, gexNetChange: div?.netChange ?? null, gexNetPct: div?.netChangePct ?? null,
    universe: ghLast ? "dynamic ATM ±10 (rebuilt from stored chains)" : null, nearAtmNet: ghLast?.near_net ?? null,
  };
'''
s = s.replace(old, new, 1)
s = s.replace('  const inputs: RegimeInputs = {\n  const inputs', '  const inputs', 1)
s = s.replace('''  warn.push("GEX-price divergence is on the Intraday GEX section and is not part of this score.");''', '''  if (!ghLast) warn.push(`GEX history: ${gexh.data?.status ?? "not loaded"}; the GEX and GEX-price conditions are not evaluable.`);
  else if (!div || div.kind === "unavailable") warn.push(`GEX-price relationship: ${div?.label ?? "needs at least two rebuilt snapshots"}.`);''', 1)

# a visible GEX-price block inside the regime panel (above the evidence lists)
s = s.replace('''        <div className="mt-2 grid gap-2 text-xs md:grid-cols-3">''', '''        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="ms-gexview">
          <Card label="GEX universe" value={<span className="text-sm">{r.gexView.universe ?? MISSING}</span>} sub="used for every GEX figure here" />
          <Card label="NIFTY change (15 min)" value={`${sg(r.gexView.spotPct)}%`} />
          <Card label="Net GEX change" value={r.gexView.netChange == null ? MISSING : `${sg(r.gexView.netChange)} cr`} sub={`${sg(r.gexView.netPct, 1)}%`} />
          <Card label="Gamma regime" value={r.gexView.gammaRegime} sub="net GEX sign, model assumption" />
          <Card label="Flip distance" value={r.gexView.flipDistancePct == null ? MISSING : `${sg(r.gexView.flipDistancePct)}%`} sub={inputs.flip == null ? "no flip within ±8%" : `flip ${fmtInt(Math.round(inputs.flip))}`} />
          <Card label="Near-ATM net GEX" value={fmtCrore(r.gexView.nearAtmNet)} sub="ATM ±5, ₹ crore" />
        </div>
        <p className="mt-1 text-xs text-muted" data-testid="ms-relationship">GEX-price relationship: {r.gexView.relationship ?? MISSING} This is a description of two series, not guaranteed dealer hedging behaviour.</p>
        <div className="mt-2 grid gap-2 text-xs md:grid-cols-3">''', 1)
open(p, "w", encoding="utf-8").write(s)
print("ok")
