---
paths:
  - "frontend/**/*.ts"
  - "frontend/**/*.tsx"
  - "frontend/**/*.css"
---
# Frontend rules
- **Stack (proposed):** React + TypeScript (strict). Confirm in [decisions](../../docs/decisions.md) before scaffolding.
- **Components:** shared UI components and design tokens (color, spacing, type, status colors) in one place; no ad hoc styling per page.
- **Responsive:** usable on desktop and mobile; tables scroll or adapt, not truncate silently.
- **Option-chain table:** sticky header and strike column, ATM highlight, clear CE/PE grouping, sortable/filterable where useful, virtualized if large, units and expiry always visible.
- **Charts:** interactive (tooltip, zoom/legend as appropriate), labeled axes/units, handle missing points as gaps, show data timestamp.
- **State:** server data via a data-fetching layer; keep WebSocket state separate from UI state; avoid global state unless needed.
- **WebSocket lifecycle:** connect/disconnect on mount/unmount, exponential-backoff reconnect, heartbeat/stale detection, resync from snapshot after reconnect, no duplicate connections.
- **Performance:** memoize heavy rows, batch/throttle high-frequency updates, avoid re-rendering the whole chain per tick.
- **Accessibility:** semantic HTML, keyboard navigation, ARIA labels, sufficient contrast, not color-only status.
- **States:** every data view has loading, empty, error, and stale states.
- **Integrity:** never display placeholder numbers as market data; no controls that do nothing; no broker credentials or tokens in the bundle or `VITE_*`-style public env vars.
