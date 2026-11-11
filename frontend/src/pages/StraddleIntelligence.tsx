import { Link } from "react-router-dom";
import { StraddleDecayPanel } from "../components/intelligence/StraddleDecay";

/** Straddle decay intelligence and the buyer/seller environments, on their own page inside Market Intelligence. */
export function StraddleIntelligence() {
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3" data-testid="straddle-page">
      <header>
        <p className="text-xs text-muted"><Link to="/market-intelligence" className="text-info hover:underline">← Market Intelligence</Link></p>
        <h1 className="text-xl font-semibold md:text-2xl">NIFTY Straddle Decay Intelligence</h1>
        <p className="text-xs text-muted">Why straddle premiums decay or hold their value, and whether conditions favour option sellers or buyers. Reads stored option-chain samples and the Market Intelligence engines; independent of the sentiment score.</p>
      </header>
      <StraddleDecayPanel />
    </div>
  );
}
