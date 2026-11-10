import type { ReactNode } from "react";

/**
 * Small decorative illustrations for the tool cards. They are drawings of what a tool shows, built from fixed shapes:
 * they carry no market data and are hidden from screen readers.
 */
export type ArtKind = "bars" | "hbars" | "lines" | "area" | "candles" | "heat" | "gauge" | "payoff" | "smile" | "table" | "diverge" | "donut" | "flow" | "pulse";

const ART: Record<string, ArtKind> = {
  "open-interest": "hbars", "multi-oi-volume": "bars", "put-call-ratio": "gauge", "max-pain": "payoff", "gamma-exposure": "diverge",
  "pe-ce-difference": "diverge", "smart-oi": "pulse", "oi-buildup": "heat", "vega-analysis": "bars",
  straddle: "area", "premium-decay": "area", "price-vs-oi": "candles", "multistrike-chart": "lines", "multi-straddle": "area", "volatility-skew": "smile", "iv-momentum": "lines", "strike-positioning": "bars", "market-structure": "gauge", "signal-backtest": "table", "iv-hv": "lines",
  "iv-intraday": "area", "oi-crossover": "lines", "intraday-booster": "pulse", "option-triggers": "gauge",
  "future-dashboard": "candles", "future-intraday": "area", "market-movers": "diverge", "future-oi": "bars",
  "future-price-oi": "candles", "fii-dii-summary": "flow", "fii-dii-cash": "flow", "index-contributors": "diverge",
  "advance-decline": "donut", "index-weightage": "donut", "sector-rotation": "heat",
  strategy: "payoff", "option-chain": "table", portfolio: "area", prediction: "lines",
};
export const artFor = (id: string): ArtKind => ART[id] ?? "bars";

const U = "var(--up)", D = "var(--down)", B = "var(--brass)", I = "var(--info)", M = "var(--muted)";

function shapes(kind: ArtKind): ReactNode {
  switch (kind) {
    case "bars": {
      const h = [30, 46, 38, 62, 50, 70, 44, 58, 36];
      return h.map((v, i) => <g key={i}><rect x={14 + i * 20} y={82 - v} width="7" rx="2" height={v} fill={U} opacity=".85" /><rect x={22 + i * 20} y={82 - v * 0.7} width="7" rx="2" height={v * 0.7} fill={D} opacity=".85" /></g>);
    }
    case "hbars": {
      const w = [120, 90, 150, 70, 100, 130];
      return w.map((v, i) => <g key={i}><rect x="20" y={10 + i * 12} width={v} height="8" rx="3" fill={i % 2 ? D : U} opacity=".85" /><rect x="20" y={10 + i * 12} width="2" height="8" fill={M} /></g>);
    }
    case "lines":
      return (<>
        {[20, 40, 60].map((y) => <line key={y} x1="10" x2="190" y1={y} y2={y} stroke={M} strokeOpacity=".25" />)}
        <polyline points="10,64 40,50 70,58 100,36 130,44 160,24 190,30" fill="none" stroke={U} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="10,52 40,60 70,42 100,50 130,30 160,40 190,22" fill="none" stroke={D} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="10,70 50,66 90,60 130,56 190,48" fill="none" stroke={I} strokeWidth="2.5" strokeDasharray="4 4" strokeLinecap="round" />
      </>);
    case "area":
      return (<>
        <defs><linearGradient id="art-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={I} stopOpacity=".55" /><stop offset="1" stopColor={I} stopOpacity="0" /></linearGradient></defs>
        <path d="M10 62 C40 60 50 30 80 36 C110 42 120 66 150 44 C170 30 180 26 190 20 L190 82 L10 82 Z" fill="url(#art-area)" />
        <path d="M10 62 C40 60 50 30 80 36 C110 42 120 66 150 44 C170 30 180 26 190 20" fill="none" stroke={I} strokeWidth="3" strokeLinecap="round" />
      </>);
    case "candles": {
      const c: [number, number, number, number, boolean][] = [[16, 40, 22, 56, true], [34, 30, 14, 50, true], [52, 34, 40, 62, false], [70, 44, 30, 60, false], [88, 28, 18, 46, true], [106, 22, 10, 40, true], [124, 30, 26, 52, false], [142, 20, 8, 36, true], [160, 26, 16, 44, true], [178, 16, 6, 30, true]];
      return c.map(([x, top, hi, lo, up], i) => <g key={i}><line x1={x + 4} x2={x + 4} y1={hi + 8} y2={lo + 8} stroke={up ? U : D} strokeWidth="2" /><rect x={x} y={top + 6} width="8" height={Math.max(8, (lo - top) * 0.6)} rx="1.5" fill={up ? U : D} /></g>);
    }
    case "heat": {
      const cells: ReactNode[] = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 12; c++) {
        const v = Math.sin(r * 1.3 + c * 0.7) + Math.cos(c * 0.5 - r);
        cells.push(<rect key={`${r}-${c}`} x={12 + c * 14.5} y={8 + r * 14.5} width="12" height="12" rx="2.5" fill={v > 0 ? U : D} opacity={0.18 + Math.min(0.75, Math.abs(v) * 0.38)} />);
      }
      return cells;
    }
    case "gauge":
      return (<>
        <path d="M30 76 A70 70 0 0 1 170 76" fill="none" stroke={M} strokeOpacity=".3" strokeWidth="12" strokeLinecap="round" />
        <path d="M30 76 A70 70 0 0 1 100 6" fill="none" stroke={D} strokeWidth="12" strokeLinecap="round" />
        <path d="M100 6 A70 70 0 0 1 170 76" fill="none" stroke={U} strokeWidth="12" strokeLinecap="round" />
        <line x1="100" y1="76" x2="132" y2="36" stroke={B} strokeWidth="4" strokeLinecap="round" /><circle cx="100" cy="76" r="6" fill={B} />
      </>);
    case "payoff":
      return (<>
        <line x1="10" x2="190" y1="50" y2="50" stroke={M} strokeOpacity=".5" strokeDasharray="3 3" />
        <path d="M10 70 L70 70 L120 20 L190 20 L190 50 L10 50 Z" fill={U} opacity=".18" />
        <polyline points="10,70 70,70 120,20 190,20" fill="none" stroke={U} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="95" cy="50" r="4.5" fill={B} />
      </>);
    case "smile":
      return (<>
        <path d="M14 20 C50 74 150 74 186 20" fill="none" stroke={I} strokeWidth="3.5" strokeLinecap="round" />
        {[30, 55, 80, 100, 120, 145, 170].map((x) => { const t = (x - 100) / 86; return <circle key={x} cx={x} cy={64 - 44 * (1 - t * t) + 0} r="4" fill={B} />; })}
      </>);
    case "table":
      return [0, 1, 2, 3, 4].map((r) => (<g key={r}>
        <rect x="12" y={8 + r * 15} width="52" height="11" rx="3" fill={U} opacity={0.3 + (r % 3) * 0.2} />
        <rect x="76" y={8 + r * 15} width="48" height="11" rx="3" fill={M} opacity=".35" />
        <rect x="136" y={8 + r * 15} width="52" height="11" rx="3" fill={D} opacity={0.3 + ((r + 1) % 3) * 0.2} />
      </g>));
    case "diverge": {
      const v = [22, -14, 30, -26, 12, 34, -18, 20, -30, 16];
      return (<><line x1="10" x2="190" y1="46" y2="46" stroke={M} strokeOpacity=".5" />{v.map((x, i) => <rect key={i} x={14 + i * 18} y={x > 0 ? 46 - x : 46} width="11" height={Math.abs(x)} rx="2.5" fill={x > 0 ? U : D} opacity=".88" />)}</>);
    }
    case "donut": {
      const seg = (from: number, to: number, color: string) => {
        const p = (a: number) => [100 + 36 * Math.cos(a), 46 + 36 * Math.sin(a)];
        const [x1, y1] = p(from), [x2, y2] = p(to);
        return <path key={color + from} d={`M${x1} ${y1} A36 36 0 ${to - from > Math.PI ? 1 : 0} 1 ${x2} ${y2}`} fill="none" stroke={color} strokeWidth="16" />;
      };
      return (<>{seg(-1.5, 0.9, U)}{seg(0.95, 2.2, D)}{seg(2.25, 4.6, I)}<circle cx="100" cy="46" r="6" fill={B} /></>);
    }
    case "flow": {
      const a = [20, 34, -16, 26, -30, 14, 38, -20];
      return (<><line x1="10" x2="190" y1="46" y2="46" stroke={M} strokeOpacity=".5" />{a.map((x, i) => (<g key={i}>
        <rect x={14 + i * 22} y={x > 0 ? 46 - x : 46} width="8" height={Math.abs(x)} rx="2" fill={x > 0 ? U : D} />
        <rect x={23 + i * 22} y={x > 0 ? 46 - x * 0.6 : 46} width="8" height={Math.abs(x) * 0.6} rx="2" fill={B} opacity=".85" /></g>))}</>);
    }
    case "pulse": {
      const v = [8, 24, -10, 34, 18, -30, -12, 26, 40, -16, 12];
      return (<>
        <line x1="8" x2="192" y1="46" y2="46" stroke={M} strokeOpacity=".5" />
        {v.map((x, i) => <rect key={i} x={12 + i * 16.5} y={x > 0 ? 46 - x : 46} width="9" height={Math.abs(x)} rx="2" fill={x > 0 ? U : D} />)}
      </>);
    }
  }
}

/** The banner on a tool card. */
export function ToolArt({ id, planned }: { id: string; planned?: boolean }) {
  return (
    <div aria-hidden className={`tool-art h-[88px] overflow-hidden rounded-[calc(var(--radius-panel)-2px)] ${planned ? "opacity-50 grayscale" : ""}`}>
      <svg viewBox="0 0 200 92" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">{shapes(artFor(id))}</svg>
    </div>
  );
}
