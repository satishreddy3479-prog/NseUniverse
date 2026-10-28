import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { fmtTimeIST } from "../lib/format";
import { useStatus } from "../lib/hooks";
import { useSignals } from "../lib/useSignals";
import { applyTheme, loadTheme, type Theme } from "../lib/theme";
import { SignalChain } from "../components/SignalChain";
import { PredictionData } from "../components/PredictionData";
import { PredictionFlows } from "../components/PredictionFlows";
import { Button, Panel } from "../components/ui";

export function Settings() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const status = useStatus();
  const qc = useQueryClient();
  const { signals, latest, expiryText } = useSignals();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === "#status") document.getElementById("status")?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  const choose = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">Display preferences, saved in this browser.</p>
      </div>
      <div id="status">
        <Panel
          title="System status"
          actions={
            <Button onClick={() => void qc.invalidateQueries()} title="Re-read status, expiries and snapshots from the backend">
              Refresh
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <SignalChain signals={signals} />
          </div>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            {signals.filter((s) => s.detail).map((s) => (
              <li key={s.key}><span className="text-paper">{s.label}:</span> {s.detail}</li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
            <div><dt className="text-muted">Selected expiries</dt><dd>{expiryText}</dd></div>
            <div><dt className="text-muted">Last snapshot</dt><dd className="num">{fmtTimeIST(latest?.retrieved_at)}</dd></div>
          </dl>
        </Panel>
      </div>
      <PredictionData />
      <PredictionFlows />
      <Panel title="Theme">
        <fieldset className="flex gap-4">
          <legend className="sr-only">Theme</legend>
          {(["dark", "light"] as const).map((t) => (
            <label key={t} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm capitalize">
              <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => choose(t)}
                className="accent-[var(--brass)]" />
              {t}
            </label>
          ))}
        </fieldset>
      </Panel>
      <Panel title="Set on the backend">
        <p className="text-sm text-muted">
          These come from <code>backend/.env</code> and are shown read-only.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-muted">Snapshot counts as stale after</dt>
            <dd className="num">{status.data ? `${status.data.snapshot_stale_after_seconds} s` : "—"}</dd></div>
          <div><dt className="text-muted">Broker</dt><dd>Kotak Neo (live data only)</dd></div>
        </dl>
      </Panel>
      <p className="text-sm text-muted">
        Default expiry mode, strike range and chart preferences will be added with the pages they control.
      </p>
    </div>
  );
}
