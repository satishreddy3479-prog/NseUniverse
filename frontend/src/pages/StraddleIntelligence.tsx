import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { ReplayBarView } from "../components/dashboard/ReplayBar";
import { ReplayProvider } from "../components/dashboard/ReplayContext";
import { StraddleDecayPanel, STRADDLE_KEY } from "../components/intelligence/StraddleDecay";
import { api } from "../lib/api";

/** The replay bar of this page: its steps are the stored samples of the analysed expiry. */
function StraddleReplay() {
  const base = useQuery({ queryKey: STRADDLE_KEY, queryFn: () => api.straddleDecay(), refetchInterval: 30_000, retry: false });
  const expiry = base.data?.expiry ?? null;
  const hist = useQuery({ queryKey: ["straddle-replay-steps", expiry], queryFn: () => api.history(expiry!, 10), enabled: !!expiry, staleTime: 60_000, retry: false });
  return <ReplayBarView observations={hist.data?.observations} ready={!!expiry} />;
}

/** Straddle decay intelligence and the buyer/seller environments, on their own page inside Market Intelligence. */
export function StraddleIntelligence() {
  return (
    <ReplayProvider>
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="straddle-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
        <p className="text-xs text-muted"><Link to="/market-intelligence" className="text-info hover:underline">← Market Intelligence</Link></p>
        <h1 className="text-xl font-semibold md:text-2xl">NIFTY Straddle Decay Intelligence</h1>
        <p className="text-xs text-muted">Why straddle premiums decay or hold their value, and whether conditions favour option sellers or buyers. Reads stored option-chain samples and the Market Intelligence engines; independent of the sentiment score.</p>
        </div>
        <ChartInfoToggle />
      </header>
      <StraddleReplay />
      <StraddleDecayPanel />
    </div>
    </ReplayProvider>
  );
}
