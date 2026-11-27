# Documentation index

Which document to read, in what order. Documents carry dates and a status line: a **plan** may be partly or fully built, an **audit** is a snapshot of one day. When a document and the code disagree, the code and `current-state.md` are right and the document is out of date; fix the document.

## Start here

| File | What it is |
|---|---|
| [current-state.md](current-state.md) | What is built, live, and unverified; newest section first. The first thing to read when resuming. |
| [../CLAUDE.md](../CLAUDE.md) | The project rules on one page. |
| [code-map.md](code-map.md) | "To change X, look in Y": backend and frontend layout. |
| [architecture.md](architecture.md) | The intended architecture and its principles. Written at the start; later pieces are in `decisions.md`. |
| [decisions.md](decisions.md) | Append-only log of decisions (`D1` to the newest at the end). Search it for the reason behind any behaviour. |
| [roadmap.md](roadmap.md) | The phases and what comes next. |

## Run and operate

| File | What it is |
|---|---|
| [setup-windows.md](setup-windows.md) | Set up and run on a Windows 11 laptop. |
| [development-workflow.md](development-workflow.md) | Laptop and Codespaces workflow. Its "local-only" stage is old: production is now server-first, see the next file. |
| [deployment-server.md](deployment-server.md) | The production VPS: how releases arrive, the deploy guard, rollback, backups, the watchdog, restore checks, SSH hardening. |
| [server-management.md](server-management.md) | The Server Management Centre page (`/server`). |
| [maintenance.md](maintenance.md) | Runbook for keeping the system healthy and what each alert means. |
| [storage-plan.md](storage-plan.md) | What is stored, how big it is, how long it is kept, the approvals needed. |
| [data-library-plan.md](data-library-plan.md) | Zip bundles of data that ages out, and temporary restore. |
| [pending-push.md](pending-push.md) | Work committed locally and waiting for the owner to push. |

## How the features work

| File | Feature |
|---|---|
| [intraday.md](intraday.md), [intraday-engine-status.md](intraday-engine-status.md) | The Intraday analysis page and the Command Center; status against the 29 Oct 2026 brief. |
| [options-intelligence.md](options-intelligence.md) | Options intelligence and the market regime from stored chain samples. |
| [market-intelligence-audit.md](market-intelligence-audit.md) | The NIFTY 50 Market Intelligence layer: design and integration audit. |
| [straddle-intelligence.md](straddle-intelligence.md) | The straddle decay engine, the buyer and seller environments, the managed straddle. |
| [strategy_builder_specification.md](strategy_builder_specification.md), [options_payoff_engine.md](options_payoff_engine.md), [testing_and_validation.md](testing_and_validation.md) | The Strategy Builder (`/strategy`), its payoff engine and its tests. |
| [advanced-greeks-plan.md](advanced-greeks-plan.md) | Advanced Greeks and What-If (built). |
| [market-breadth-plan.md](market-breadth-plan.md) | Breadth, heavyweights, volume, sectors. |
| [smart-oi-divergence-plan.md](smart-oi-divergence-plan.md), [smart-oi-research.md](smart-oi-research.md) | Smart OI divergence indicators: plan, and the research on stored sessions. |
| [swing-backtest.md](swing-backtest.md), [swing-live-paper-fills-plan.md](swing-live-paper-fills-plan.md) | The swing engine: backtest research and the live paper ledger. |
| [nse_universe_integration_plan.md](nse_universe_integration_plan.md), [opstra_public_feature_audit.md](opstra_public_feature_audit.md) | Early scope work for the Strategy Builder. |

## Audits (snapshots in time)

[audit-checkpoint1.md](audit-checkpoint1.md) (28 Oct 2026), [audit-2026-10-29.md](audit-2026-10-29.md), [audit-2026-10-30.md](audit-2026-10-30.md), [audit-2026-11-11.md](audit-2026-11-11.md), [straddle-intelligence-audit.md](straddle-intelligence-audit.md) (19 Nov), [audit-2026-11-26.md](audit-2026-11-26.md) (the latest full audit: code, server and one session of logs).

## Keeping this index honest

When a document is added, add a line here. When a plan is built, change its status line at the top of the plan and record it in `current-state.md` and `decisions.md`. Do not delete old audits; they are the evidence for later decisions.
