export type Theme = "dark" | "light" | "ocean";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "ocean", label: "Ocean" },
  { id: "dark", label: "Dark" },
];
const KEY = "nse-universe.theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "ocean" ? v : "dark";
  } catch {
    return "dark";
  }
}

/** Browser / installed-app title bar colour for each theme. */
const BAR: Record<Theme, string> = { dark: "#172233", light: "#ffffff", ocean: "#0a3340" };

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[t]);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: theme still applies for this visit */
  }
}
