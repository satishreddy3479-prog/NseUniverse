export type Theme = "dark" | "light";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const KEY = "nse-universe.theme";

/** Saved choice; anything else (including the removed "ocean" theme) opens as dark. */
export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Browser / installed-app title bar colour for each theme. */
const BAR: Record<Theme, string> = { dark: "#172233", light: "#ffffff" };

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[t]);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: theme still applies for this visit */
  }
}
