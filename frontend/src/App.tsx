import { lazy, Suspense, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DataSessions } from "./pages/DataSessions";
import { Diagnostics } from "./pages/Diagnostics";
import { OptionChain } from "./pages/OptionChain";
import { Overview } from "./pages/Overview";
import { Planned } from "./pages/Planned";
import { Settings } from "./pages/Settings";

// Loaded on demand so the charting library is not part of the first page.
const Analysis = lazy(() => import("./pages/Analysis"));
const Prediction = lazy(() => import("./pages/Prediction"));
const StrategyBuilder = lazy(() => import("./pages/StrategyBuilder"));

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
  });
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
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
        <Route path="charts" element={<Navigate to="/analysis" replace />} />
        <Route path="data" element={<DataSessions />} />
        <Route path="diagnostics" element={<Diagnostics />} />
        <Route path="settings" element={<Settings />} />
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
