---
name: build-widget
description: Build or change a widget on the Analysis dashboard (/analysis) following its existing data context, chart builders and design system. Use when asked to add a chart, table or panel to the dashboard.
---
# Build a dashboard widget
Scope: `frontend/src/pages/Analysis.tsx`, `components/dashboard/`, `lib/chartOptions.ts`, `lib/analytics.ts`. For non-widget features use `implement-feature`; for the maths use `verify-quant`.

1. **Inspect first.** Read `components/dashboard/widgets.tsx` (the `WIDGETS` registry, `Meta`, `ChainGuard`, `TimeSeries`), `DashContext.tsx` (what `useDash()` already provides: rows, view, totals, atmStrike, selected, history, toggles) and `lib/chartOptions.ts`. If an existing widget or builder can be extended, extend it; do not add a duplicate.
2. **Define the data.** State which `useDash()` fields or API endpoints the widget needs. Prefer the shared context so every widget agrees. A new endpoint needs backend tests (`backend/tests/unit`) and a type in `lib/types.ts` + `lib/api.ts`.
3. **Pure logic first.** Calculation in `analytics.ts` (missing values skipped and counted, never 0); chart option in `chartOptions.ts` as a pure function returning the ECharts option. Time series use stored snapshots only; never invent points.
4. **Compose the widget.** Register in `WIDGETS` (id, title, default 12-column box, min size). Use `ChainGuard`, `Meta` (source, expiry, universe, snapshot time) and the shared tokens/`ui.tsx` components. Respect the Calls/Puts toggles and the selected strike.
5. **States are required:** loading, no snapshot (with a "Fetch snapshot" action), fewer than 2 observations, all-identical observations (market closed), stale/live source label, API error. Every control must do something.
6. **Interactions:** clicks select a strike via `select()`; tooltips show units; nothing decorative.
7. **Test:** chart-builder test with exact series data and gaps for nulls; page test in `src/test/analysis.test.tsx` (EChart is stubbed there; jsdom has no canvas) covering the states above, add/remove/reset.
8. **Verify** with the `test-dashboard` skill, then look at it in the running app (`/analysis`) at desktop width and a narrow width.

Done when: widget works with real stored snapshots, all states render, tests/type-check/build pass, and the report lists modified files, commands run with results, and open issues. Update `docs/current-state.md`.
