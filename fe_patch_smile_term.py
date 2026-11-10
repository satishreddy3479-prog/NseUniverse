R = r"C:\Users\SATISH~1\AppData\Local\Temp\claude\S--Nseuniverse\fd06f634-3462-470d-ac50-67680b70a03e\scratchpad\repo_main\frontend\src"

p = R + r"\lib\types.ts"
s = open(p, encoding="utf-8").read()
old = s[s.index("export interface TermStructure {"):s.index("}\n", s.index("export interface TermStructure {")) + 2]
s = s.replace(old, '''export interface TermSeries {
  slope_per_30d: number | null; shape: "contango" | "backwardation" | "flat" | null; difference: number | null;
  near: { expiry: string; days: number; value: number } | null; far: { expiry: string; days: number; value: number } | null;
  pairs: { near: string; far: string; slope: number }[]; left_out: { expiry: string; reason: string }[];
}
export interface TermStructure {
  slope_per_30d: number | null; shape: "contango" | "backwardation" | "flat" | null; iv_difference?: number | null;
  near: { expiry: string; days: number; atm_iv: number } | null; far: { expiry: string; days: number; atm_iv: number } | null;
  pairs: { near: string; far: string; slope: number }[]; left_out: { expiry: string; reason: string }[];
  series?: Record<string, TermSeries>;
}
''', 1)
s = s.replace("  term_structure?: TermStructure;\n  cards?:", "  term_structure?: TermStructure;\n  session?: string; sessions?: string[];\n  cards?:", 1)
open(p, "w", encoding="utf-8").write(s)

p = R + r"\lib\api.ts"
s = open(p, encoding="utf-8").read()
s = s.replace("  intradayIvSkew: (expiry: string) => request<IvSkew>(`/api/intraday/iv-skew?expiry=${encodeURIComponent(expiry)}`),", "  intradayIvSkew: (expiry: string, session?: string) => request<IvSkew>(`/api/intraday/iv-skew?expiry=${encodeURIComponent(expiry)}${session ? `&session=${encodeURIComponent(session)}` : \"\"}`),", 1)
open(p, "w", encoding="utf-8").write(s)

p = R + r"\lib\metricRegistry.ts"
s = open(p, encoding="utf-8").read().rstrip()
assert s.endswith("};")
s = s.replace('''steps: ["Take the expiries with a chain stored within 5 minutes of the chosen one and a solved ATM IV.",''', '''steps: ["Take the expiries with a chain stored within 5 minutes of the chosen one and a solved value for the series (ATM IV, 25Δ and 10Δ call and put IV by the same delta interpolation, and the two skews); each series gets its own slope.",''', 1)
s = s[:-2] + '''  smile_compare: {
    id: "smile_compare", version: "1", title: "Smile comparison between sessions",
    measures: "How the implied-volatility smile of one expiry differs between two stored sessions, at ATM, 25 delta and 10 delta, strike by strike.",
    formula: ["Change = measure(now) − measure(then), each measure from its own smile", "ATM IV, 25Δ and 10Δ call and put IV: the same delta interpolation as the skew cards (IV = IV_lo + (target − Δ_lo)/(Δ_hi − Δ_lo) × (IV_hi − IV_lo))", "Skew = put IV − call IV at the same delta", "Strike alignment: rows are the union of strikes; delta and IV of each side are shown for both sessions, a missing observation stays missing"],
    computedBy: { frontend: "compareRows / ivAtDelta (components/SmileCompare.tsx, lib/skew.ts)", backend: "iv_skew with the session parameter (app/intraday/service.py)" },
    unit: "implied-volatility points", sign: "Now minus then. Positive: the measure is higher now.",
    inputs: [{ name: "Smile (strike, side, delta, IV)", source: "the last in-session stored chain of each session, out-of-the-money options, Black-76 on the forward from put-call parity", unit: "%, fraction", kind: "derived" }, { name: "Expiry", source: "the same expiry for both sessions (no matching across expiries)", unit: "date", kind: "raw" }],
    steps: ["Load the last in-session chain of each session for the chosen expiry.", "Solve both smiles with the same model, rate and strike window.", "Interpolate the delta points on each smile separately and subtract.", "List every strike observation of both smiles side by side."],
    reading: { positive: "That part of the smile is richer than in the comparison session.", negative: "Cheaper than in the comparison session.", rising: "Not applicable.", falling: "Not applicable.", nearZero: "Unchanged between the sessions." },
    assumptions: ["Days to expiry differ between the two sessions, so a level change mixes a shape change with time: ATM IV is not time-scaled.", "Strikes and deltas shift with spot: compare the delta rows, not only the strike rows.", "Only the same expiry is compared; an expiry with no stored chain on the other session cannot be compared."],
  },
};
'''
open(p, "w", encoding="utf-8").write(s)

p = R + r"\components\IvSkew.tsx"
s = open(p, encoding="utf-8").read()
s = s.replace('import { MethodologyPanel } from "./MethodologyPanel";', 'import { MethodologyPanel } from "./MethodologyPanel";\nimport { SmileComparePanel, toView } from "./SmileCompare";\nimport { TermStructureView } from "./TermStructureView";', 1)
# comparison state and query (hooks before any early return)
s = s.replace('''  const q = useQuery({ queryKey: ["ivSkew", expiry], queryFn: () => api.intradayIvSkew(expiry!), enabled: !!expiry, refetchInterval: 30_000, retry: false });''', '''  const q = useQuery({ queryKey: ["ivSkew", expiry], queryFn: () => api.intradayIvSkew(expiry!), enabled: !!expiry, refetchInterval: 30_000, retry: false });
  // comparison session: the previous stored session of the same expiry unless the user picks another or none
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const sessionList = q.data?.sessions ?? [];
  const prevDefault = sessionList.length >= 2 ? sessionList[sessionList.length - 2]! : null;
  const cmpSession = picked === undefined ? prevDefault : picked;
  const cmpQ = useQuery({ queryKey: ["ivSkew", expiry, cmpSession], queryFn: () => api.intradayIvSkew(expiry!, cmpSession!), enabled: !!expiry && !!cmpSession && view === "Smile", staleTime: 300_000, retry: false });''', 1)
# union strike axis and dashed comparison series
s = s.replace("  const strikeAxis = [...new Set(s.smile.map((p) => p.strike))].sort((x, y) => x - y);", "  const thenSmile = cmpSession && cmpQ.data?.status === \"ok\" ? cmpQ.data.smile : [];\n  const strikeAxis = [...new Set([...s.smile, ...thenSmile].map((p) => p.strike))].sort((x, y) => x - y);", 1)
old = '''      { name: "Put IV (OTM)", type: "line", showSymbol: true, symbolSize: 5, connectNulls: false, data: strikeAxis.map((k) => s.smile.find((p) => p.strike === k && p.side === "PE")?.iv ?? null), lineStyle: { color: c.down, width: 2 }, itemStyle: { color: c.down } },'''
assert old in s
s = s.replace(old, old + '''
      ...(thenSmile.length ? [
        { name: `Call IV ${cmpSession}`, type: "line", showSymbol: false, connectNulls: false, data: strikeAxis.map((k) => thenSmile.find((p) => p.strike === k && p.side === "CE")?.iv ?? null), lineStyle: { color: c.up, width: 1.5, type: "dashed", opacity: 0.8 }, itemStyle: { color: c.up } },
        { name: `Put IV ${cmpSession}`, type: "line", showSymbol: false, connectNulls: false, data: strikeAxis.map((k) => thenSmile.find((p) => p.strike === k && p.side === "PE")?.iv ?? null), lineStyle: { color: c.down, width: 1.5, type: "dashed", opacity: 0.8 }, itemStyle: { color: c.down } },
      ] : []),''', 1)
# panel under the smile chart
old = '''          </>
        )}
        {view === "Term" && ('''
assert old in s
s = s.replace(old, '''            <SmileComparePanel now={{ label: live ? "Live" : "Now", session: live ? null : (stored?.session ?? null), expiry: s.expiry, atmIv: s.atm_iv ?? null, at: s.at ?? null, smile: s.smile.map((p) => ({ strike: p.strike, side: p.side, iv: p.iv, delta: p.delta ?? null })) }}
              then={cmpSession && cmpQ.data?.status === "ok" ? toView(cmpQ.data, cmpSession) : null} sessions={sessionList} value={cmpSession ?? null} onChange={(v) => setPicked(v)}
              loading={!!cmpSession && cmpQ.isLoading} error={cmpQ.isError ? (cmpQ.error instanceof Error ? cmpQ.error.message : "error") : cmpQ.data && cmpQ.data.status !== "ok" ? cmpQ.data.status : null} />
          </>
        )}
        {view === "Term" && (''', 1)
# term view: new component replaces the old chart and table
a = s.index('            <div style={{ height: 320 }} data-testid="ivskew-term"><EChart option={term}')
b = s.index("            {stored?.term_structure && (")
s = s[:a] + "            {stored && <TermStructureView d={stored} />}\n" + s[b:]
open(p, "w", encoding="utf-8").write(s)
print("ok")
