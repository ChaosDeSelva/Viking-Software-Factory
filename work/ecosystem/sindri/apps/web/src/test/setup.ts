import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  window.history.replaceState(null, "", "/");
  document.title = "";
});
