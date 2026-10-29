# NSE Universe integration plan: strategy builder

Written after reading the repository and the running server (30 Oct 2026).

## What exists and is reused

| Area | Finding | Reuse |
|---|---|---|
| Stack | FastAPI backend, React + TypeScript + Vite frontend, ECharts, TanStack Query, Tailwind | The builder is a normal lazy-loaded route; no new dependency |
| Navigation | `components/SideNav.tsx`, routes in `App.tsx` | New entry "Strategy builder" at `/strategy` |
| Contract data | `/api/expiries`, `/api/option-chain?expiry=` return the stored chain: strikes, LTP, OI, lot size, spot | Strikes, market premiums, lot size and spot come only from here. Lot size is read from the chain, never hard-coded |
| Option history | `ObservationStore` (`market` SQLite): one sample a minute in market hours with every contract's LTP/OI, **since 28 Oct 2026** | The backtester reads it (read-only) |
| Pricing maths | `backend/app/intraday/volatility.py` (Black-76, implied vol, Greeks) | Ported to `frontend/src/lib/strategy.ts`; shared test vectors generated from the Python code |
| Session | New `backend/app/domain/session.py` / `frontend/src/lib/session.ts` | One constant for the 09:15 to 15:40 IST session (derivatives close since 3 Aug 2026) |
| Charts, UI | `EChart`, `Panel`, `Button`, theme colours | Same design system |
| Auth | Control endpoints trust loopback; read-only endpoints are open | Backtest and availability endpoints are read-only; nothing writes |
| Deployment | Push to `main` auto-deploys to the VPS (1 GB RAM) | The backtest reads a few hundred samples per session and returns JSON; memory is small. No new job or service |

## Where the new code lives

* `frontend/src/lib/strategy.ts`: payoff, breakevens, risk, Black-76 valuation, Greeks, costs, templates, validation (pure, no UI, no network).
* `frontend/src/pages/StrategyBuilder.tsx` and `components/BacktestPanel.tsx`: the page.
* `backend/app/strategy/backtest.py`, `costs.py`: the historical test engine.
* Routes in `api/routes.py`: `GET /api/strategy/availability`, `POST /api/strategy/backtest`.
* Tests: `src/test/strategy.test.ts`, `strategy-page.test.tsx`, `backend/tests/unit/test_strategy_backtest.py`.

## Data that does not exist (so features that need it are not built)

* **Option price history before 28 Oct 2026.** Historical options backtesting over months or years needs an options data vendor (no source is configured and none is invented here). Result: the backtester runs on a handful of sessions and says so.
* **Bid/ask.** Only last traded prices are stored.
* **Other indices (BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX).** No contract master or chain collection exists. The builder says NIFTY only; adding one needs its own instrument data and collection first.
* **Intrabar data between samples.** Stop-loss and target are checked on the stored samples only.

## Preservation

No existing page, route, store or API was changed except: the nav entry, the session constant (close moved from 15:30 to 15:40), and two read-only helper methods on `ObservationStore`.
