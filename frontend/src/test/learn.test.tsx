// The Learn page teaches every tool in the app: a tool added without a lesson, or a lesson without a worked example, fails here.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FOUNDATIONS, learnSections, LESSONS } from "../lib/learn";
import { TOOLS } from "../lib/tools";
import { SYSTEM } from "../components/TopNav";
import { Learn } from "../pages/Learn";

describe("Learn: nothing is missing", () => {
  it("every tool in the menus (the Trend & Regime tabs included) has a lesson, and every lesson belongs to a tool", () => {
    const ids = new Set(LESSONS.map((l) => l.id));
    expect(TOOLS.filter((t) => !ids.has(t.id)).map((t) => t.id)).toEqual([]);
    const toolIds = new Set(TOOLS.map((t) => t.id));
    expect(LESSONS.filter((l) => !toolIds.has(l.id)).map((l) => l.id)).toEqual([]);
    expect(ids.size).toBe(LESSONS.length); // no duplicates
  });

  it("every lesson says the idea, how to read it, a worked example with its reading, and what to avoid", () => {
    for (const l of [...FOUNDATIONS, ...LESSONS]) {
      expect(l.idea.length, l.id).toBeGreaterThan(40);
      expect(l.read.length, l.id).toBeGreaterThanOrEqual(1);
      expect(l.example.setup.length, l.id).toBeGreaterThan(20);
      expect(l.example.reading.length, l.id).toBeGreaterThan(20);
      expect(l.watch.length, l.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("the sections follow the menus: start here, FNO Tools, Analyse", () => {
    expect(learnSections().map((s) => s.title)).toEqual(["Start here", "FNO Tools", "Analyse"]);
  });

  it("is a link in the System menu", () => {
    expect(SYSTEM.find((x) => x.to === "/learn")?.label).toBe("Learn");
  });
});

describe("the Learn page", () => {
  const page = () => render(<MemoryRouter><Learn /></MemoryRouter>);

  it("renders a card for every tool and every foundation lesson", () => {
    page();
    for (const t of TOOLS) expect(screen.getByTestId(`lesson-${t.id}`), t.id).toBeInTheDocument();
    for (const f of FOUNDATIONS) expect(screen.getByTestId(`lesson-${f.id}`), f.id).toBeInTheDocument();
  });

  it("links each lesson to its tool", () => {
    page();
    const card = screen.getByTestId("lesson-open-interest");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/tools/open-interest");
    expect(screen.getByTestId("lesson-trend-strength").querySelector("a")?.getAttribute("href")).toBe("/trend/trend-strength");
  });

  it("the search narrows the lessons and says so when nothing matches", () => {
    page();
    fireEvent.change(screen.getByLabelText("Search the lessons"), { target: { value: "gamma flip" } });
    expect(screen.getByTestId("lesson-gamma-exposure")).toBeInTheDocument();
    expect(screen.queryByTestId("lesson-option-chain")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search the lessons"), { target: { value: "zzzzqqq" } });
    expect(screen.getByRole("status")).toHaveTextContent("No lesson matches");
  });
});
