import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lacks these; Radix popper and the theme hook call them.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= function () {};

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.history.replaceState(null, "", "/");
  document.title = "";
});
