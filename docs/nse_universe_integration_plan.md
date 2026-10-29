# NSE Universe integration plan: strategy builder

Written after reading the repository and the running server (30 Oct 2026).

## What exists and is reused

| Area | Finding | Reuse |
|---|---|---|
| Stack | FastAPI backend, React + TypeScript + Vite frontend, ECharts, TanStack Query, Tailwind | The builder is a normal lazy-loaded route; no new dependency |
| Navigation | `components/SideNav.tsx`, routes in `App.tsx` | New entry "Strategy builder" at `/strategy` |
| Contract data | `/api/expiries`, `/api/option-chain?expiry=` return the stored chain: strikes, LTP, OI, lot size, spot | Strikes, market premiums, lot size and spot come only from here. Lot size is read from the chain, never hard-coded |
| Option history | `ObservationStore`: one sample a minute from the 29 Oct 2026 session | Not used by the builder |
| Session | New `backend/app/domain/session.py` / `frontend/src/lib/session.ts` | One constant for the 09:15 to 15:40 IST session (derivatives close since 3 Aug 2026) |
| Charts, UI | `EChart`, `Panel`, `Button`, theme colours | Same design system |
| Auth | Control endpoints trust loopback | The builder only reads |
| Deployment | Push to `main` auto-deploys to the VPS | Frontend only; no new job or service |

## Where the new code lives
* `frontend/src/lib/strategy.ts`: legs, expiry payoff, breakevens, max profit and loss, templates, validation.
* `frontend/src/pages/StrategyBuilder.tsx`: the page (option chain, strategy, payoff). Route `/strategy`.
* `payoffOption` in `lib/chartOptions.ts`; tests `strategy.test.ts`, `strategy-page.test.tsx`.
* No backend change for the builder: it reads the existing `/api/expiries` and `/api/option-chain`.

## Data limits
Option history exists only from the 29 Oct 2026 session (one usable session on 30 Oct), no bid/ask, NIFTY only. That is why a historical backtester was removed and is not part of the builder.

## Preservation
Besides the nav entry and the page, the only shared change is the 09:15-15:40 IST session constant (derivatives close since 3 Aug 2026).
