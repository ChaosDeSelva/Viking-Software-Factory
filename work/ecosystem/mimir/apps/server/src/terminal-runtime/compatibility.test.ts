import { expect, it } from "vitest";
import { acceptsKimiPrompt } from "./compatibility.js";
it("does not equate the newer Kimi unattended prompt mode with the older permission-preserving CLI", () => {
  expect(acceptsKimiPrompt("--prompt --auto Never Ask --yolo")).toBe(false);
  expect(acceptsKimiPrompt("--config-file --wire --print --prompt")).toBe(true);
  expect(acceptsKimiPrompt("--prompt")).toBe(false);
  expect(acceptsKimiPrompt("--config-file --wire --print --auto Never Ask")).toBe(false);
});
