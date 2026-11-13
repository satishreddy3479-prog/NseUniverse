import { useState } from "react";
import { applyTheme, loadTheme, type Theme } from "../lib/theme";

const Sun = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a8.5 8.5 0 1 0 11.5 11.5z" />
  </svg>
);

/** One button for the two themes, remembered in this browser: it shows what a click switches to (a moon in the day theme, a sun in the night theme). */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const next: Theme = theme === "light" ? "dark" : "light";
  const label = next === "dark" ? "Switch to the night theme" : "Switch to the day theme";
  return (
    <button type="button" data-theme-now={theme} aria-label={label} title={label} onClick={() => { applyTheme(next); setTheme(next); }}
      className="grid size-9 shrink-0 place-items-center rounded-full border border-rule bg-slate-2 text-brass hover:text-paper">
      {next === "dark" ? <Moon /> : <Sun />}
    </button>
  );
}
