import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Says so when the device has lost its network connection, and brings every page's data up to date the moment it returns. Without it a lost
 * connection looked like a stalled market: numbers stopped moving and nothing explained why.
 */
export function OfflineStrip() {
  const qc = useQueryClient();
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [back, setBack] = useState(false);
  useEffect(() => {
    const on = () => { setOnline(true); setBack(true); void qc.invalidateQueries(); window.setTimeout(() => setBack(false), 4000); };
    const off = () => { setOnline(false); setBack(false); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [qc]);
  if (online && !back) return null;
  return online ? (
    <div role="status" className="border-b border-up/40 bg-up/10 px-3 py-1.5 text-center text-sm font-medium text-up" data-testid="online-again">Back online. Refreshing the data.</div>
  ) : (
    <div role="alert" className="border-b border-warn/50 bg-warn/10 px-3 py-1.5 text-center text-sm font-medium text-warn" data-testid="offline-strip">
      You are offline. The numbers on screen are the last ones received and are not updating; they refresh by themselves when the connection returns.
    </div>
  );
}
