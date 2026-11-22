// The OI bar of the builder's chain: length against the largest on its side, the wall solid and marked, a missing OI is a dash, never a zero bar.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OiBar } from "../components/OiBar";

const bar = (el: HTMLElement) => el.querySelector('[role="img"] > div') as HTMLElement | null;

describe("OiBar", () => {
  it("is as long as its share of the largest OI on the side: 25 of 100 is 25 %, the largest is full", () => {
    const { rerender } = render(<OiBar side="call" value={250_000} max={1_000_000} color="#0a0" />);
    expect(bar(screen.getByTestId("oibar-call"))!.style.width).toBe("25%");
    rerender(<OiBar side="call" value={1_000_000} max={1_000_000} color="#0a0" wall />);
    expect(bar(screen.getByTestId("oibar-call"))!.style.width).toBe("100%");
  });
  it("shows the number above the bar, marks the wall, and the bar of a tiny value stays visible (3 % at least)", () => {
    render(<OiBar side="put" value={1_000} max={10_000_000} color="#a00" />);
    expect(bar(screen.getByTestId("oibar-put"))!.style.width).toBe("3%");
    expect(screen.getByTestId("oibar-put")).toHaveTextContent("1.0 K");
    expect(screen.getByTestId("oibar-put")).not.toHaveAttribute("data-wall");
  });
  it("the wall is solid and marked", () => {
    render(<OiBar side="put" value={5_000_000} max={5_000_000} color="#a00" wall />);
    expect(screen.getByTestId("oibar-put")).toHaveAttribute("data-wall", "true");
    expect(screen.getByTestId("oibar-put")).toHaveTextContent("▪");
    expect(screen.getByRole("img").getAttribute("title")).toContain("the most on this side");
    expect(bar(screen.getByTestId("oibar-put"))!.style.opacity).toBe("1");
  });
  it("a missing OI is a dash with an empty track and no bar; zero OI is an empty track too, with its number", () => {
    const { rerender } = render(<OiBar side="call" value={null} max={100} color="#0a0" />);
    expect(screen.getByTestId("oibar-call")).toHaveTextContent("—");
    expect(bar(screen.getByTestId("oibar-call"))).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "no open interest stored");
    rerender(<OiBar side="call" value={0} max={100} color="#0a0" />);
    expect(bar(screen.getByTestId("oibar-call"))).toBeNull();
    expect(screen.getByTestId("oibar-call")).toHaveTextContent("0");
  });
  it("calls grow toward the strike on the right, puts toward the strike on the left", () => {
    const { container } = render(<><OiBar side="call" value={50} max={100} color="#0a0" /><OiBar side="put" value={50} max={100} color="#a00" /></>);
    const tracks = container.querySelectorAll('[role="img"]');
    expect(tracks[0]!.className).toContain("justify-end");
    expect(tracks[1]!.className).not.toContain("justify-end");
  });
});
