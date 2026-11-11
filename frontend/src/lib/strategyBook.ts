/**
 * What the Strategy builder derives from ONE expiry's option chain: the implied forward and carry (put-call parity), the Black-76 Greeks and
 * implied volatility of every listed contract, the at-the-money strike and its implied volatility. A strategy with legs on several expiries
 * keeps one book per expiry, so each leg is priced, valued and hedged with its own expiry's numbers (a far expiry has its own forward and
 * its own volatility; nothing from the near chain is reused for it).
 */
import { carryFromForward, contractGreeks, impliedForward, type ContractGreeks, type ImpliedForward } from "./optionModel";
import type { OptionType } from "./strategy";

export interface BookRow { strike: number; call: { ltp: number | null } | null; put: { ltp: number | null } | null }

export interface Book {
  expiry: string;
  strikes: number[];
  fwd: ImpliedForward | null;
  /** continuous carry that reproduces the forward; the interest rate when the chain gives no usable parity */
  carry: number;
  cg: Map<number, { ce: ContractGreeks | null; pe: ContractGreeks | null }>;
  deltas: Map<number, { ce: number | null; pe: number | null; ceIv: number | null; peIv: number | null }>;
  atmK: number | null;
  atmIv: number | null;
}

const px = (q: { ltp: number | null } | null | undefined): number | null => (q?.ltp != null && q.ltp > 0 ? q.ltp : null);

export function buildBook(rows: readonly BookRow[], expiry: string, spot: number | null, nowMs: number, rate: number): Book {
  const strikes = rows.map((r) => r.strike);
  const fwd = spot != null ? impliedForward(rows.map((x) => ({ strike: x.strike, call: x.call?.ltp ?? null, put: x.put?.ltp ?? null })), spot, expiry, nowMs, rate) : null;
  const fwdCarry = fwd && spot != null ? carryFromForward(spot, fwd.forward, expiry, nowMs) : null;
  const carry = fwdCarry ?? rate;
  const cg = new Map<number, { ce: ContractGreeks | null; pe: ContractGreeks | null }>();
  if (spot != null) {
    for (const row of rows) {
      cg.set(row.strike, { ce: contractGreeks("CE", px(row.call), spot, row.strike, expiry, nowMs, rate, carry), pe: contractGreeks("PE", px(row.put), spot, row.strike, expiry, nowMs, rate, carry) });
    }
  }
  const deltas = new Map<number, { ce: number | null; pe: number | null; ceIv: number | null; peIv: number | null }>();
  for (const [k, v] of cg) deltas.set(k, { ce: v.ce?.delta ?? null, pe: v.pe?.delta ?? null, ceIv: v.ce?.iv ?? null, peIv: v.pe?.iv ?? null });
  const ref = fwd?.forward ?? spot;
  const atmK = ref == null || strikes.length === 0 ? null : strikes.reduce((b, k) => (Math.abs(k - ref) < Math.abs(b - ref) ? k : b), strikes[0]!);
  const d = atmK == null ? undefined : deltas.get(atmK);
  const ivs = [d?.ceIv, d?.peIv].filter((x): x is number => x != null);
  return { expiry, strikes, fwd, carry, cg, deltas, atmK, atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null };
}

/** The implied volatility the stored market price of this contract gives, null when the chain has no usable price for it. */
export function marketIvOf(book: Book | undefined, strike: number, type: OptionType): number | null {
  const d = book?.deltas.get(strike);
  return (type === "CE" ? d?.ceIv : d?.peIv) ?? null;
}
