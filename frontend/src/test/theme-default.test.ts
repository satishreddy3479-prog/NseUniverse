import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, loadTheme } from "../lib/theme";

afterEach(() => localStorage.clear());

describe("the day theme is the default", () => {
  it("opens in the day theme when nothing is saved or the saved value is unknown", () => {
    expect(loadTheme()).toBe("light");
    localStorage.setItem("nse-universe.theme", "ocean"); // a removed theme
    expect(loadTheme()).toBe("light");
  });
  it("keeps a saved night choice", () => {
    applyTheme("dark");
    expect(loadTheme()).toBe("dark");
    applyTheme("light");
    expect(loadTheme()).toBe("light");
  });
});
