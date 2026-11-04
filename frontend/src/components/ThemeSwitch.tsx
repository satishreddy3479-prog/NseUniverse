import { useState } from "react";
import { applyTheme, loadTheme, THEMES, type Theme } from "../lib/theme";

/** Light / Ocean / Dark, remembered in this browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <div role="group" aria-label="Theme" className="inline-flex overflow-hidden rounded-sm border border-rule text-xs">
      {THEMES.map(({ id, label }) => (
        <button key={id} type="button" aria-pressed={theme === id} title={`${label} theme`}
          onClick={() => { applyTheme(id); setTheme(id); }}
          className={`min-h-8 px-2 ${theme === id ? "bg-slate-2 font-medium text-paper" : "text-muted hover:text-paper"}`}>{label}</button>
      ))}
    </div>
  );
}
