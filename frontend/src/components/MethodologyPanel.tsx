import type { ReactNode } from "react";
import type { MetricDef } from "../lib/metricRegistry";
import { MISSING } from "../lib/format";

export interface Freshness { updatedAt: string | null; session: string | null; expiry: string | null; used: number | null; missing: number | null; timeframe?: string | null }

const H = ({ children }: { children: ReactNode }) => <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted first:mt-0">{children}</h4>;
const Pre = ({ lines }: { lines: string[] }) => <pre className="mt-1 whitespace-pre-wrap break-words rounded-sm bg-slate-2 p-2 font-mono text-[12px] leading-relaxed text-paper">{lines.join("\n")}</pre>;

/**
 * The "Calculation Methodology & Formulas" panel that closes an analytical section. It is closed by default and renders only
 * what the metric registry and the section's own data give it: the formulas come from the registry, the worked example is
 * produced by the calculation on the data on screen, and the freshness line states what was used and what was left out.
 */
export function MethodologyPanel({ metrics, example, freshness }: { metrics: MetricDef[]; example: string[]; freshness: Freshness }) {
  return (
    <details className="mt-3 rounded-sm border border-rule bg-slate-2/40" data-testid="methodology">
      <summary className="cursor-pointer px-3 py-2 text-sm text-info">Calculation Methodology &amp; Formulas</summary>
      <div className="px-3 pb-3 text-xs text-muted [overflow-wrap:anywhere]">
        {metrics.map((m) => (
          <section key={m.id} className="mb-4 border-b border-rule/50 pb-3 last:border-0" data-testid={`methodology-${m.id}`}>
            <div className="text-sm font-semibold text-paper">{m.title} <span className="font-normal text-muted">· definition v{m.version}</span></div>
            <H>A. What it measures</H><p>{m.measures}</p>
            <H>B. Formula used</H><Pre lines={m.formula} />
            <p className="mt-1">Unit: {m.unit}. Sign convention: {m.sign}</p>
            <H>C. Input variables</H>
            <ul className="mt-1 list-disc space-y-1 pl-5">{m.inputs.map((i) => <li key={i.name}><span className="text-paper">{i.name}</span> ({i.kind}): {i.source}; {i.unit}{i.note ? `; ${i.note}` : ""}</li>)}</ul>
            <H>D. Calculation steps</H>
            <ol className="mt-1 list-decimal space-y-1 pl-5">{m.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <H>F. Interpretation</H>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li><span className="text-paper">Positive:</span> {m.reading.positive}</li><li><span className="text-paper">Negative:</span> {m.reading.negative}</li>
              <li><span className="text-paper">Increasing:</span> {m.reading.rising}</li><li><span className="text-paper">Decreasing:</span> {m.reading.falling}</li>
              <li><span className="text-paper">Near zero:</span> {m.reading.nearZero}</li>
            </ul>
            <H>G. Assumptions and limitations</H>
            <ul className="mt-1 list-disc space-y-1 pl-5">{m.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="mt-2 text-[11px]">Computed by {[m.computedBy.frontend && `browser: ${m.computedBy.frontend}`, m.computedBy.backend && `server: ${m.computedBy.backend}`].filter(Boolean).join("; ")}.</p>
          </section>
        ))}
        <H>E. Worked example (from the data on screen)</H>
        {example.length ? <Pre lines={example} /> : <p className="mt-1">No example: the inputs needed are not available in this snapshot.</p>}
        <H>H. Data freshness</H>
        <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="methodology-freshness">
          <li>Last update: {freshness.updatedAt ?? MISSING}</li><li>Session: {freshness.session ?? MISSING}</li><li>Expiry: {freshness.expiry ?? MISSING}</li>
          {freshness.timeframe && <li>Timeframe: {freshness.timeframe}</li>}
          <li>Observations used: {freshness.used ?? MISSING}; missing or excluded: {freshness.missing ?? MISSING}</li>
        </ul>
        <H>I. Verification</H>
        <p className="mt-1">The browser and server formulas are pinned to the same hand-calculated cases in their test suites; this text is generated from the registry entry of each metric, version shown above.</p>
      </div>
    </details>
  );
}
