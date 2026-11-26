import { useEffect, useState } from "react";
import { reloadFresh, watchBuild } from "../lib/buildWatch";

/** Shown in a tab that was open when a new version of the app went live. */
export function UpdateBanner() {
  const [newer, setNewer] = useState(false);
  useEffect(() => watchBuild(() => setNewer(true)), []);
  if (!newer) return null;
  return (
    <div role="status" data-testid="update-banner" className="flex flex-wrap items-center justify-center gap-3 border-b border-brass/40 bg-brass/15 px-3 py-1.5 text-sm text-paper">
      <span>A new version of NSE Universe is available.</span>
      <button type="button" onClick={() => void reloadFresh()} className="min-h-8 rounded-sm border border-brass bg-slate-2 px-3 text-sm font-medium text-paper hover:bg-brass/20">Reload now</button>
    </div>
  );
}
