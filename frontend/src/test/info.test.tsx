import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Info } from "../components/Info";
import { WIDGETS } from "../components/dashboard/widgets";
import { GLOSSARY_SIZE, lookup } from "../lib/glossary";

describe("glossary", () => {
  it("explains every Analysis widget and every intraday card title", () => {
    for (const w of WIDGETS) expect(lookup(w.title), `widget: ${w.title}`).not.toBeNull();
    for (const t of [
      "Current market sentiment", "Evidence breakdown", "Market regime & scenarios", "Market breadth & move quality", "NIFTY 50 heavyweights",
      "Breakout intelligence", "Setup monitor", "Implied volatility & Greeks", "Options positioning detail", "Futures flow and top-5 heavyweights", "Sectors",
      "Forward check of the rules-based sentiment", "Prediction model research (15 min)", "Paper trading of the setups (after costs)", "Session replay",
      "Intraday decision context", "Key levels", "Options positioning", "Data coverage & warnings", "Global, sectors & flows", "Events & ML model",
      "Sentiment history (today, stored)",
    ]) expect(lookup(t), `card: ${t}`).not.toBeNull();
  });

  it("explains the strategy statistics and matches titles that only start with a known term", () => {
    for (const t of ["P&L now (vs entry)", "POP (model estimate)", "Reward : Risk", "Max profit", "Max loss", "Breakevens", "Net premium", "Net Δ (model)", "If targets hit", "If stops hit"]) {
      expect(lookup(t), t).not.toBeNull();
    }
    expect(lookup("Model comparison — T+1 — untouched holdout 2026")).not.toBeNull();
    expect(lookup("Institutional positions — NSE F&O participant open interest (net = long − short, contracts)")).not.toBeNull();
    expect(lookup("A label nobody wrote help for")).toBeNull();
  });

  it("every entry says what it is and how to read it", () => {
    expect(GLOSSARY_SIZE).toBeGreaterThan(60);
    for (const t of ["Key levels", "PCR: ATM and overall", "Max loss", "Delta"]) {
      const e = lookup(t)!.entry;
      expect(e.what.length).toBeGreaterThan(20); expect(e.read.length).toBeGreaterThan(20);
    }
  });
});

describe("Info button", () => {
  it("opens an explanation on click and closes with Escape or the close button; nothing is drawn without an entry", async () => {
    const { container } = render(<div><span>Key levels</span><Info term="Key levels" /><Info term="No such label" /></div>);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    const btn = screen.getByRole("button", { name: "Help: how to read this" });
    await userEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/What it is\./)).toBeInTheDocument();
    expect(within(dlg).getByText(/How to read it\./)).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(btn);
    await userEvent.click(await screen.findByRole("button", { name: "Close help" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
