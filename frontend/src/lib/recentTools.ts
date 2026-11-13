import { useEffect, useState } from "react";
import { TOOLS, toolPath, type Tool } from "./tools";

/** The tools last opened on this device, newest first. Kept in the browser only; nothing leaves it. */
const KEY = "nse-universe.recent-tools";
const KEEP = 8;
const EVENT = "nse-recent-tools";

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The tool whose page this address is, if any (the tool pages, the option chain and other ready tools). */
export function toolAt(pathname: string): Tool | undefined {
  const p = pathname.replace(/\/+$/, "") || "/";
  return TOOLS.find((t) => toolPath(t) === p);
}

export function recordTool(id: string): void {
  const next = [id, ...load().filter((x) => x !== id)].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recents simply do not persist */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Records the tool on the current address, once per visit to it. */
export function useRecordTool(pathname: string): void {
  useEffect(() => {
    const t = toolAt(pathname);
    if (t) recordTool(t.id);
  }, [pathname]);
}

/** The most recently used tools that still exist and are ready, up to ``n``; with ``menu``, only that menu's own tools. */
export function useRecentTools(n = 3, menu?: string): Tool[] {
  const [ids, setIds] = useState<string[]>(load);
  useEffect(() => {
    const sync = () => setIds(load());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return ids.map((id) => TOOLS.find((t) => t.id === id)).filter((t): t is Tool => !!t && toolPath(t) !== null && (!menu || t.menu === menu)).slice(0, n);
}
