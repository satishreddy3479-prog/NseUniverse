import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { watchForStaleBuild } from "./lib/chunkReload";
import { hydratePrefs, installPrefsSync } from "./lib/prefs";
import { applyTheme, loadTheme } from "./lib/theme";
import "./index.css";

applyTheme(loadTheme()); // at once, from this browser's copy, so the page does not flash the wrong theme while the server answers
watchForStaleBuild();

async function start() {
  // The owner's layouts and choices live on the server: bring them into this browser BEFORE any page is loaded (several modules read them when they are first imported), so a second
  // browser or PC opens with the same app. With no answer within a few seconds the app opens with this browser's own copy.
  await hydratePrefs();
  installPrefsSync();
  applyTheme(loadTheme());
  const { default: App, prefetchPages } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // The other pages are fetched in the background once this one has loaded, so moving between tools is instant.
  const prefetch = () => prefetchPages();
  if (document.readyState === "complete") prefetch(); else window.addEventListener("load", prefetch);
}
void start();

// Installable app: the service worker caches only the static shell, never market data (see public/sw.js).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => { /* app still works without it */ }); });
}
