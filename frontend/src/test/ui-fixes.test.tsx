// Small interface fixes: the drawn info icon, one purple tab underline, the day's high and low labelled as such.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChartInfoToggle } from "../components/ChartInfoToggle";
import { Tabs } from "../components/swing/shared";

describe("info icon", () => {
  it("is a drawn icon, not the font glyph that rendered squashed in some fonts", () => {
    const { container } = render(<ChartInfoToggle />);
    const btn = screen.getByTestId("chart-info-toggle");
    expect(btn.textContent).toBe("Hide chart info"); // no glyph character in the text
    expect(btn.textContent).not.toContain("ⓘ");
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("tab underline", () => {
  it("the selected section tab underlines in the accent colour (one tone), not brass", () => {
    render(<Tabs tabs={[{ id: "a", label: "Overview" }, { id: "b", label: "Evidence" }]} value="a" onChange={() => {}} label="Sections" />);
    const on = screen.getByRole("tab", { name: "Overview" });
    expect(on.className).toContain("border-accent");
    expect(on.className).not.toContain("border-brass");
    expect(screen.getByRole("tab", { name: "Evidence" }).className).toContain("border-transparent");
  });
  it("the stylesheet draws no second line on a tab that already has its own border", () => {
    const css = readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\[role="tab"\]\[class\*="border-b-2"\]\[aria-selected="true"\]\s*\{\s*box-shadow:\s*none/);
  });
});
