/**
 * The Strategy Builder's strategy as a position for the Advanced Greeks page: its open, ticked legs (lots x multiplier x lot size, long positive), each option with the
 * volatility its own stored market price implies and the carry of its expiry's chain. Only the Builder's strategy is analysed, never legs typed elsewhere.
 * A leg whose price gives no volatility keeps iv null, so the analyses leave it out and say so.
 */
import type { Leg } from "./strategy";
import { isExited, sign } from "./strategy";
import { buildBook, marketIvOf, type Book, type BookRow } from "./strategyBook";
import type { PLeg } from "./advancedGreeks";

export interface ChainInput { expiry: string; rows: readonly BookRow[]; spot: number | null }
export interface BuilderPosition { legs: PLeg[]; spot: number | null; books: Map<string, Book>; unvalued: string[] }

export function buildPosition(doc: readonly Leg[] | undefined, chains: readonly ChainInput[], nowMs: number, rate: number, lotSize: number | null, mult = 1): BuilderPosition {
  const spot = chains.find((c) => c.spot != null)?.spot ?? null;
  const books = new Map<string, Book>();
  for (const c of chains) books.set(c.expiry, buildBook(c.rows, c.expiry, c.spot ?? spot, nowMs, rate));
  const legs: PLeg[] = [], unvalued: string[] = [];
  if (lotSize == null) return { legs, spot, books, unvalued };
  for (const l of doc ?? []) {
    if (l.enabled === false || isExited(l)) continue;
    const b = books.get(l.expiry);
    const qty = sign(l.action) * l.lots * mult * lotSize;
    if (l.type === "FUT") { legs.push({ id: l.id, type: "FUT", strike: 0, expiry: l.expiry, qty, iv: null, carry: b?.carry ?? rate, entry: l.premium, enteredAt: l.enteredAt ?? null }); continue; }
    const iv = marketIvOf(b, l.strike, l.type);
    if (iv == null) unvalued.push(`${l.strike} ${l.type} ${l.expiry}`);
    legs.push({ id: l.id, type: l.type, strike: l.strike, expiry: l.expiry, qty, iv, carry: b?.carry ?? rate, entry: l.premium, enteredAt: l.enteredAt ?? null });
  }
  return { legs, spot, books, unvalued };
}
