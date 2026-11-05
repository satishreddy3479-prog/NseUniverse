import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtTimeIST } from "../lib/format";
import { FlowCard, Sectors } from "./CommandCenter";

/** Futures flow / heavyweights and the sector table, moved here from the Intraday Booster page (Future Lab). */
export function FuturesFlowBody({ expiry, part }: { expiry: string | null; part: "flow" | "sectors" }) {
  const q = useQuery({
    queryKey: ["intradaySummary", expiry],
    queryFn: () => api.intradaySummary(expiry!),
    enabled: !!expiry,
    refetchInterval: 15_000,
    retry: false,
  });
  const d = q.data;
  if (!expiry) return <p className="text-sm text-muted">Waiting for the expiry list from the broker.</p>;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-[var(--radius-panel)] border border-rule bg-slate" aria-label="Loading" />;
  if (q.isError || !d)
    return (
      <p role="alert" className="rounded-sm border border-down/50 p-3 text-sm text-down">
        This could not be computed: {q.error instanceof Error ? q.error.message : "unknown error"}.
      </p>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="futures-flow-tool">
      <div className="text-xs text-muted">computed {fmtTimeIST(d.generated_at)} · market mode: {d.market.mode}</div>
      <div className="flex flex-wrap gap-3">{part === "flow" ? <FlowCard d={d} /> : <Sectors d={d} />}</div>
    </div>
  );
}
