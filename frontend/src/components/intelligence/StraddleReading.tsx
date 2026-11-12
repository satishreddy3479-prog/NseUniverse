import { MISSING } from "../../lib/format";
import type { StraddleDecay } from "../../lib/straddleDecay";
import { straddleReading, type Mode } from "../../lib/straddleVerdict";
import { BUYER_ZONES, Gauge, SELLER_ZONES } from "./StraddleGlance";

const sg = (v: number | null | undefined, d = 1) => (v == null ? MISSING : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);

function Answer({ q, children }: { q: string; children: React.ReactNode }) {
  return <div className="min-w-0 rounded-md bg-slate-2 px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted">{q}</div><div className="mt-0.5 text-sm text-paper">{children}</div></div>;
}

/** The first thing on the page: whether conditions favour selling or buying option premium right now, where the followed straddle stands, what holds the scores back and what would change them. */
export function StraddleReadingCard({ d, mode }: { d: StraddleDecay; mode: Mode }) {
  const r = straddleReading(d);
  const env = d.environment;
  return (
    <section aria-label="Straddle reading" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4 md:p-5" data-testid="sdi-reading-card">
      <div className="text-[11px] uppercase tracking-wide text-muted">NIFTY straddles right now</div>
      <h2 className="mt-0.5 text-xl font-semibold text-paper md:text-2xl">Is it a good time to sell or to buy option premium?</h2>
      {env ? (
        <p className="mt-2 max-w-[75ch] rounded-md bg-slate-2 px-3 py-2 text-[15px] leading-snug text-paper" data-testid="sdi-glance-verdict"><span className="font-semibold">In plain words: </span>{r.headline}</p>
      ) : <p className="mt-2 text-sm text-muted">{r.headline}</p>}

      {env && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Gauge testid="sdi-gauge-seller" title="Seller environment" subtitle="Is it a good time to SELL option premium (straddles, strangles)?" score={env.seller.score} cls={env.seller.class} zones={SELLER_ZONES} capped={env.seller.capped_by_flags} trend={d.environment_trend?.seller} coverage={env.seller.coverage} />
          <Gauge testid="sdi-gauge-buyer" title="Buyer environment" subtitle="Is it a good time to BUY options (calls, puts, long straddles)?" score={env.buyer.score} cls={env.buyer.class} zones={BUYER_ZONES} trend={d.environment_trend?.buyer} coverage={env.buyer.coverage} />
        </div>
      )}

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <Answer q="Where is the straddle?">
          {r.positions.length === 0 ? <span className="text-muted">No straddle sample yet.</span> : (
            <ul className="space-y-1.5" data-testid="sdi-reading-positions">
              {r.positions.map((p) => (
                <li key={p.name}><span className={`font-medium ${p.name.startsWith(mode === "fixed" ? "Fixed" : "Rolling") ? "text-paper" : "text-muted"}`}>{p.name}</span>
                  <span className="num block text-xs text-muted">{p.open == null ? MISSING : p.open.toFixed(1)} at the open → {p.now == null ? MISSING : p.now.toFixed(1)} now ({sg(p.change)} points): {p.words}.</span></li>
              ))}
            </ul>
          )}
        </Answer>
        <Answer q="What is holding the scores back?">
          {r.cautions.length === 0 ? <span className="text-muted" data-testid="sdi-reading-nocaution">Nothing is flagged.</span> : <ul className="list-disc space-y-1 pl-4 text-warn" data-testid="sdi-reading-cautions">{r.cautions.map((c) => <li key={c}><span className="text-paper">{c}</span></li>)}</ul>}
        </Answer>
        <Answer q="What would change this?">
          {r.invalidation.length === 0 ? <span className="text-muted">Not available.</span> : <ul className="list-disc space-y-1 pl-4" data-testid="sdi-reading-invalidation">{r.invalidation.map((x) => <li key={x}>{x}</li>)}</ul>}
        </Answer>
      </div>

      {r.climate && (
        <p className="mt-3 text-sm text-paper" data-testid="sdi-reading-climate">Premium-decay climate: <b>{r.climate.label}</b>{r.climate.text ? <span className="text-muted"> · {r.climate.text}</span> : null}</p>
      )}
      <p className="mt-3 text-[11px] leading-snug text-muted">Descriptive only, not a trading signal, and separate from the market sentiment score. The scores are provisional and missing inputs are left out, never counted as neutral.</p>
    </section>
  );
}
