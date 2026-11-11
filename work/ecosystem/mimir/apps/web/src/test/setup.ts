import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lacks these; Radix popper (Select, Combobox, Tooltip, Dialog) calls them.
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
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-theme");
});
