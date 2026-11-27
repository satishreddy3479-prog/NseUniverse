// The Learn page teaches every tool in the app: a tool added without a lesson, or a lesson without a worked example, fails here.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FOUNDATIONS, learnSections, LESSONS } from "../lib/learn";
import { F, GUIDES } from "../lib/learnGuides";
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

describe("the How it works guides", () => {
  const page = () => render(<MemoryRouter><Learn /></MemoryRouter>);

  it("has a guide for each of the three engines, each with step-by-step sections, formulas and worked examples", () => {
    expect(GUIDES.map((g) => g.id)).toEqual(["guide-market-intelligence", "guide-straddle-engine", "guide-trend-regime"]);
    for (const g of GUIDES) {
      expect(g.sections.length, g.id).toBeGreaterThanOrEqual(7);
      const kinds = new Set(g.sections.flatMap((s) => s.blocks.map((b) => b.k)));
      for (const k of ["formula", "worked", "table"] as const) expect(kinds.has(k), `${g.id} ${k}`).toBe(true);
      if (g.id === "guide-market-intelligence") expect(kinds.has("steps")).toBe(true);
      expect(g.sections.filter((s) => s.blocks.some((b) => b.k === "worked")).length, g.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("renders every guide and every section on the page, with formulas and worked examples", () => {
    page();
    for (const g of GUIDES) {
      expect(screen.getByTestId(`guide-${g.id}`)).toBeInTheDocument();
      for (const s of g.sections) expect(document.getElementById(s.id), s.id).not.toBeNull();
    }
    expect(screen.getAllByTestId("guide-formula").length).toBeGreaterThanOrEqual(10);
    expect(screen.getAllByTestId("guide-worked").length).toBeGreaterThan(10);
  });

  it("quotes the engine's own weights: the Market Intelligence table and the seller and buyer weights add to what the guide says", () => {
    page();
    const mi = screen.getByTestId("guide-guide-market-intelligence");
    for (const [id, w] of Object.entries(F.mi.weights)) expect(mi.textContent, id).toContain(`(${w})`);
    expect(Object.values(F.mi.weights).reduce((a, b) => a + b, 0)).toBe(100);
    const st = screen.getByTestId("guide-guide-straddle-engine");
    expect(st.textContent).toContain(`The weights add to ${Object.values(F.straddle.seller_weights).reduce((a, b) => a + b, 0)}.`);
    expect(st.textContent).toContain(`The weights add to ${Object.values(F.straddle.buyer_weights).reduce((a, b) => a + b, 0)}.`);
  });

  it("explains the points a reader asked about: the Shapley split, the straddle efficiency classes, the trend score ramps and the dwell rule", () => {
    page();
    expect(screen.getByTestId("guide-guide-straddle-engine").textContent).toContain("Shapley");
    expect(screen.getByTestId("guide-guide-trend-regime").textContent).toContain("Dwell");
    expect(screen.getByTestId("guide-guide-trend-regime").textContent).toContain("Trend score = (0.70 + 0.25 + 0.70 + 0.288) / 4 = 0.485");
  });

  it("the search finds guides by their content, and the nav lists them", () => {
    page();
    fireEvent.change(screen.getByLabelText("Search the lessons"), { target: { value: "shapley" } });
    expect(screen.getByTestId("guide-guide-straddle-engine")).toBeInTheDocument();
    expect(screen.queryByTestId("guide-guide-trend-regime")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search the lessons"), { target: { value: "" } });
    expect(screen.getAllByText("How it works").length).toBeGreaterThan(0);
  });
});
