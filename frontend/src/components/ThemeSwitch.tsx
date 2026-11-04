import { useState } from "react";
import { applyTheme, loadTheme, type Theme } from "../lib/theme";

const Sun = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
    <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a8.5 8.5 0 1 0 11.5 11.5z" />
  </svg>
);

/** Sun / moon switch for the two themes, remembered in this browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const pick = (t: Theme) => { applyTheme(t); setTheme(t); };
  const cls = (on: boolean) => `grid size-8 place-items-center rounded-full ${on ? "bg-brass/20 text-brass" : "text-muted hover:text-paper"}`;
  return (
    <div role="group" aria-label="Theme" className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-rule bg-slate-2 p-0.5">
      <button type="button" aria-pressed={theme === "light"} aria-label="Light" title="Light theme" onClick={() => pick("light")} className={cls(theme === "light")}><Sun /></button>
      <button type="button" aria-pressed={theme === "dark"} aria-label="Dark" title="Dark theme" onClick={() => pick("dark")} className={cls(theme === "dark")}><Moon /></button>
    </div>
  );
}
