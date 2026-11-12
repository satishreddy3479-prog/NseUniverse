import { fmtTimeIST, MISSING } from "../../lib/format";
import type { EngineView, Intelligence } from "../../lib/intelligence";
import { plainName, verdict, type Tone } from "../../lib/miVerdict";

const TONE: Record<Tone, { text: string; bar: string; ring: string }> = {
  bullish: { text: "text-up", bar: "bg-up", ring: "border-up/50" }, bearish: { text: "text-down", bar: "bg-down", ring: "border-down/50" },
  neutral: { text: "text-paper", bar: "bg-muted", ring: "border-rule" }, unknown: { text: "text-muted", bar: "bg-muted", ring: "border-rule" },
};
const sgn = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`;

function Answer({ q, a, sub, tone }: { q: string; a: string; sub: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{q}</div>
      <div className={`text-base font-semibold ${tone ?? "text-paper"}`}>{a}</div>
      <div className="text-xs leading-snug text-muted">{sub}</div>
    </div>
  );
}

/** The first thing on the page: what the market is doing in plain words, how far to trust it, what changed lately and what would change the view. */
export function VerdictCard({ d }: { d: Intelligence }) {
  const v = verdict(d);
  const t = TONE[v.tone];
  const pos = v.score == null ? 50 : Math.min(100, Math.max(0, (v.score + 100) / 2));
  const stale = d.engines.filter((e) => e.freshness.fresh === false);
  const trustTone = v.trust.level === "High" ? "text-up" : v.trust.level === "Low" ? "text-warn" : "text-paper";
  const changeTone = v.changed.lean === "bullish" ? "text-up" : v.changed.lean === "bearish" ? "text-down" : "text-paper";
  return (
    <section aria-label="Market reading" className={`rounded-[var(--radius-panel)] border bg-slate p-4 md:p-5 ${t.ring}`} data-testid="mi-verdict">
      <div className="text-[11px] uppercase tracking-wide text-muted">NIFTY 50 right now</div>
      <h2 className={`mt-0.5 text-3xl font-semibold ${t.text}`} data-testid="mi-verdict-label">{v.label}</h2>
      <div className="mt-2 max-w-[34rem]" aria-hidden>
        <div className="relative h-2.5 rounded-full bg-slate-2" style={{ backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--down) 28%, transparent), transparent 50%, color-mix(in srgb, var(--up) 28%, transparent))" }}>
          <div className={`absolute inset-y-0 rounded-full opacity-60 ${t.bar}`} style={{ left: `${Math.min(pos, 50)}%`, width: `${Math.abs(pos - 50)}%` }} />
          <div className="absolute -inset-y-[3px] left-1/2 w-0.5 bg-muted/60" />
          <div className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate ${t.bar}`} style={{ left: `${pos}%` }} />
        </div>
        <div className="mt-0.5 flex justify-between text-[10px] text-muted"><span>bearish −100</span><span>0</span><span>+100 bullish</span></div>
      </div>
      <p className="mt-3 max-w-[70ch] text-[15px] leading-snug text-paper" data-testid="mi-verdict-headline">{v.headline}</p>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <Answer q="How far can I trust it?" a={v.trust.level === "Unknown" ? "Unknown" : `${v.trust.level} trust`} sub={v.trust.text || "No quality figure is available."} tone={trustTone} />
        <Answer q="What changed in 20 minutes?" a={v.changed.lean === "none" ? "Nothing sustained" : v.changed.lean === "unavailable" ? "Not available" : v.changed.lean === "mixed" ? "Mixed" : v.changed.lean === "bullish" ? "Turning up" : "Turning down"} sub={v.changed.text} tone={changeTone} />
        <Answer q="What kind of market is it?" a={d.regime.name} sub={`${d.sentiment.volatility_regime} volatility · gamma ${d.regime.gamma}${d.regime.previous ? ` · was ${d.regime.previous}` : ""}`} />
      </div>

      {(v.reasons.for.length > 0 || v.reasons.against.length > 0) && (
        <div className="mt-3 grid gap-2 md:grid-cols-2" data-testid="mi-reasons">
          <div className="rounded-md border border-rule px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted">{v.tone === "bearish" ? "What points down" : "What points up"}</div>
            {v.reasons.for.length === 0 ? <p className="text-sm text-muted">No group is clearly on this side.</p> : <ul className="text-sm">{v.reasons.for.map((r) => <li key={r.name} className="flex justify-between gap-2"><span className="text-paper">{r.name}</span><span className={`num ${r.score >= 0 ? "text-up" : "text-down"}`}>{sgn(r.score)}</span></li>)}</ul>}</div>
          <div className="rounded-md border border-rule px-3 py-2"><div className="text-[11px] uppercase tracking-wide text-muted">{v.tone === "bearish" ? "What points up" : "What points down"}</div>
            {v.reasons.against.length === 0 ? <p className="text-sm text-muted">No group is clearly on this side.</p> : <ul className="text-sm">{v.reasons.against.map((r) => <li key={r.name} className="flex justify-between gap-2"><span className="text-paper">{r.name}</span><span className={`num ${r.score >= 0 ? "text-up" : "text-down"}`}>{sgn(r.score)}</span></li>)}</ul>}</div>
        </div>
      )}

      {v.watch.length > 0 && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2" data-testid="mi-watch">
          {v.watch.map((w) => <div key={w.label}><dt className="text-[11px] uppercase tracking-wide text-muted">{w.label}</dt><dd className="text-paper">{w.text}</dd></div>)}
        </dl>
      )}

      <p className="mt-3 text-[11px] leading-snug text-muted" data-testid="mi-verdict-foot">
        Updated {fmtTimeIST(d.generated_at)} · session {d.session} · expiry {d.expiry ?? MISSING}
        {stale.length > 0 && <span className="text-warn"> · stale, not shown as live: {stale.map((e) => plainName(e.name)).join(", ")}</span>}
        . This describes the evidence; it is not a forecast. The weights are provisional and evidence quality is not a probability.
      </p>
    </section>
  );
}

const STATUS_TAG: Record<string, string> = { PARTIAL: "partial", UNAVAILABLE: "no reading" };

/** The five evidence groups as one bar each, from bearish (left) to bullish (right), so the picture is readable at a glance. */
export function EngineBars({ d, onMore }: { d: Intelligence; onMore: () => void }) {
  return (
    <section aria-label="Evidence at a glance" className="rounded-[var(--radius-panel)] border border-rule bg-slate p-4" data-testid="mi-bars">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-paper">Evidence at a glance <span className="font-normal text-muted">· each group scored from −100 (bearish) to +100 (bullish)</span></h2>
        <button type="button" onClick={onMore} className="text-sm text-info hover:underline">See the evidence behind each →</button>
      </div>
      <ul className="mt-3 space-y-2">
        {d.engines.map((e: EngineView) => {
          const s = e.score, w = s == null ? 0 : Math.min(50, Math.abs(s) / 2);
          const tags = [e.freshness.fresh === false ? "stale" : null, e.status && STATUS_TAG[e.status] ? STATUS_TAG[e.status] : null].filter(Boolean) as string[];
          return (
            <li key={e.key} className="grid grid-cols-[minmax(0,9.5rem)_1fr_3rem] items-center gap-2 md:grid-cols-[14rem_1fr_4rem]" data-testid="mi-bar">
              <div className="min-w-0"><div className="truncate text-sm text-paper">{plainName(e.name)}</div>{tags.length > 0 && <div className="text-[11px] text-warn">{tags.join(" · ")}</div>}</div>
              <div className="relative h-3 rounded-full bg-slate-2" role="img" aria-label={s == null ? `${plainName(e.name)}: no reading` : `${plainName(e.name)}: ${sgn(s)}`}>
                <div className="absolute inset-y-0 left-1/2 w-px bg-rule" />
                {s != null && <div className={`absolute inset-y-0 rounded-full ${s >= 0 ? "bg-up" : "bg-down"}`} style={s >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />}
              </div>
              <div className={`num text-right text-sm font-semibold ${s == null ? "text-muted" : s >= 0 ? "text-up" : "text-down"}`}>{s == null ? MISSING : sgn(s)}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
