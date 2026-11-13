import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { prefetchPages } from "./App";
import { watchForStaleBuild } from "./lib/chunkReload";
import { applyTheme, loadTheme } from "./lib/theme";
import "./index.css";

applyTheme(loadTheme());
watchForStaleBuild();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The other pages are fetched in the background once this one has loaded, so moving between tools is instant.
window.addEventListener("load", () => prefetchPages());

// Installable app: the service worker caches only the static shell, never market data (see public/sw.js).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => { /* app still works without it */ }); });
}
