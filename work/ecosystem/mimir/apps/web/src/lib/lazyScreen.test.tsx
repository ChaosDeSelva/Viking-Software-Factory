import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { lazyScreen } from "./lazyScreen.js";

describe("lazyScreen", () => {
  it("renders the loaded component", async () => {
    const Hello = lazyScreen(() => Promise.resolve(() => <p>Loaded</p>));
    render(
      <Suspense fallback={null}>
        <Hello />
      </Suspense>,
    );
    expect(await screen.findByText("Loaded")).toBeTruthy();
  });

  it("shows a reload prompt instead of throwing when the chunk is gone", async () => {
    const Gone = lazyScreen(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module")),
    );
    render(
      <Suspense fallback={null}>
        <Gone />
      </Suspense>,
    );
    expect(await screen.findByText("This part of Mimir did not load")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry|reload/i })).toBeTruthy();
  });
});
