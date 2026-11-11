import { lazy, Suspense, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DataSessions } from "./pages/DataSessions";
import { OptionChain } from "./pages/OptionChain";
import { Home } from "./pages/Home";
import { Overview } from "./pages/Overview";
import { Planned } from "./pages/Planned";

// Loaded on demand so the charting library is not part of the first page.
const Analysis = lazy(() => import("./pages/Analysis"));
const Prediction = lazy(() => import("./pages/Prediction"));
const Swing = lazy(() => import("./pages/Swing"));
const StrategyBuilder = lazy(() => import("./pages/StrategyBuilder"));
const ToolPage = lazy(() => import("./pages/ToolPage"));
// Pages that are not the first thing anyone opens are split off too, so the first screen loads only what it shows.
const named = <T extends Record<string, React.ComponentType>>(load: () => Promise<T>, key: keyof T & string) => lazy(() => load().then((m) => ({ default: m[key] as React.ComponentType })));
const MarketIntelligence = named(() => import("./pages/MarketIntelligence"), "MarketIntelligence");
const StraddleIntelligence = named(() => import("./pages/StraddleIntelligence"), "StraddleIntelligence");
const DataCleanup = named(() => import("./pages/DataCleanup"), "DataCleanup");
const ServerManagement = named(() => import("./pages/ServerManagement"), "ServerManagement");
const Portfolio = named(() => import("./pages/Portfolio"), "Portfolio");
const Diagnostics = named(() => import("./pages/Diagnostics"), "Diagnostics");
const Settings = named(() => import("./pages/Settings"), "Settings");
const wait = (what: string, el: React.ReactNode) => <Suspense fallback={<p className="text-muted" role="status">Loading {what}…</p>}>{el}</Suspense>;

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
  });
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="market-intelligence" element={wait("market intelligence", <MarketIntelligence />)} />
        <Route path="market-intelligence/straddle" element={wait("straddle intelligence", <StraddleIntelligence />)} />
        <Route path="overview" element={<Overview />} />
        <Route path="tools/:id" element={
          <Suspense fallback={<p className="text-muted">Loading tool…</p>}><ToolPage /></Suspense>} />
        <Route path="option-chain" element={<OptionChain />} />
        <Route path="expiry-comparison" element={
          <Planned title="Expiry comparison" when="Checkpoint 3">
            <p>Weekly and monthly chains side by side: dates, contract counts, snapshot times, subscription status and OI/volume charts.</p>
          </Planned>} />
        <Route path="analysis" element={
          <Suspense fallback={<p className="text-muted">Loading analysis…</p>}><Analysis /></Suspense>} />
        <Route path="prediction" element={
          <Suspense fallback={<p className="text-muted">Loading prediction…</p>}><Prediction /></Suspense>} />
        <Route path="strategy" element={
          <Suspense fallback={<p className="text-muted">Loading strategy builder…</p>}><StrategyBuilder /></Suspense>} />
        <Route path="swing" element={
          <Suspense fallback={<p className="text-muted">Loading swing trading…</p>}><Swing /></Suspense>} />
        <Route path="charts" element={<Navigate to="/analysis" replace />} />
        <Route path="data" element={<DataSessions />} />
        <Route path="portfolio" element={wait("portfolio", <Portfolio />)} />
        <Route path="cleanup" element={wait("data clean-up", <DataCleanup />)} />
        <Route path="server" element={wait("server management", <ServerManagement />)} />
        <Route path="diagnostics" element={wait("diagnostics", <Diagnostics />)} />
        <Route path="settings" element={wait("settings", <Settings />)} />
        <Route path="*" element={<p className="text-muted">Page not found.</p>} />
      </Route>
    </Routes>
  );
}

export default function App() {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
