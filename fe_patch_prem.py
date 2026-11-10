R = r"C:\Users\SATISH~1\AppData\Local\Temp\claude\S--Nseuniverse\fd06f634-3462-470d-ac50-67680b70a03e\scratchpad\repo_main\frontend\src"

p = R + r"\lib\types.ts"
s = open(p, encoding="utf-8").read()
s += '''
export interface PremiumBasketPoint {
  at: string; spot: number; strikes: number; ce: number | null; pe: number | null; ce_n: number; pe_n: number; ce_mean: number | null; pe_mean: number | null;
  ce_idx: number | null; pe_idx: number | null; ce_change: number | null; pe_change: number | null; ce_pct: number | null; pe_pct: number | null;
  asymmetry: { ratio: number | null; note: string | null };
}
export interface PremiumBaskets {
  status: string; expiry: string; session: string; kind: "fixed" | "dynamic"; window: number | null; snapshots: number; points: PremiumBasketPoint[];
  age_seconds: number; latest_at: string; basket: string;
}
'''
open(p, "w", encoding="utf-8").write(s)

p = R + r"\lib\api.ts"
s = open(p, encoding="utf-8").read()
s = s.replace("  intradayIvSkew:", "  intradayPremiumBaskets: (expiry: string, window = \"10\", kind = \"fixed\") => request<import(\"./types\").PremiumBaskets>(`/api/intraday/premium-baskets?expiry=${encodeURIComponent(expiry)}&window=${window}&kind=${kind}`),\n  intradayIvSkew:", 1)
open(p, "w", encoding="utf-8").write(s)

p = R + r"\lib\metricRegistry.ts"
s = open(p, encoding="utf-8").read().rstrip()
assert s.endswith("};")
s = s[:-2] + '''  premium_chart: {
    id: "premium_chart", version: "1", title: "Aggregate CE and PE premium (fixed and dynamic baskets)",
    measures: "The total premium of the call and put options in a basket of strikes at every snapshot of the session, how it changed since the first snapshot, and which side moved more.",
    formula: [
      "CE premium(t) = Σ over the basket's strikes of the call last traded price (PE the same); only strikes with a price are counted",
      "Change(t) = premium(t) − premium(first);  % change = (premium(t) / premium(first) − 1) × 100",
      "Fixed basket: the ATM ± n strikes of the first snapshot, kept all session. Dynamic basket: ATM ± n around each snapshot's own spot",
      "Normalised index: fixed = 100 × total(t) / total(first); dynamic = 100 × mean premium per strike(t) / mean(first)",
      "Premium asymmetry = |PE change since first| / |CE change since first|; missing when the CE change is under 0.2 % of the opening CE basket",
    ],
    computedBy: { backend: "basket_series (app/intraday/strike_positioning.py)" },
    unit: "₹ per unit of premium; index 100 = first snapshot; ratio unitless", sign: "Change: now minus first snapshot of the session.",
    inputs: [{ name: "Premium", source: "stored last traded prices of the chosen expiry, last sample of each 5-minute bucket", unit: "₹", kind: "raw" }, { name: "n", source: "5, 10, 20 listed strikes either side of ATM, or all strikes", unit: "strikes", kind: "raw" }, { name: "NIFTY", source: "spot stored with each snapshot", unit: "index points", kind: "raw" }],
    steps: ["Choose the strikes: fixed once at the first snapshot, or again at every snapshot.", "Sum the available call and put prices; record how many were priced.", "Subtract and divide by the first snapshot's totals.", "Compute the asymmetry from the two changes."],
    reading: { positive: "Premium above its opening level: options richer (spot movement, volatility or less decay than expected).", negative: "Premium below its opening level: decay or falling volatility.", rising: "Aggregate premium expanding.", falling: "Contracting.", nearZero: "Little change since the open." },
    assumptions: ["Premium moves with NIFTY, time decay and volatility together; a change is not by itself a volatility change.", "In a dynamic basket the total changes when strikes enter and leave: use the normalised mean per strike to compare over time.", "An unpriced strike is left out of the sum, so the counts are shown."],
  },
};
'''
open(p, "w", encoding="utf-8").write(s)

p = R + r"\components\StrikePositioning.tsx"
s = open(p, encoding="utf-8").read()
s = s.replace('import { MethodologyPanel } from "./MethodologyPanel";', 'import { MethodologyPanel } from "./MethodologyPanel";\nimport { PremiumBasketChart } from "./PremiumBasketChart";', 1)
anchor = '      <div className="rounded-[var(--radius-panel)] border border-rule bg-slate p-3">\n        <h2 className="mb-2 text-sm font-semibold text-paper">Aggregate premium: fixed and dynamic baskets, premium asymmetry</h2>'
assert anchor in s
s = s.replace(anchor, '      <PremiumBasketChart expiry={d.expiry} />\n' + anchor, 1)
open(p, "w", encoding="utf-8").write(s)
print("ok")
