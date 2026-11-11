import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lacks the layout APIs the `@factory/ui` popovers and lists call.
if (typeof window !== "undefined") {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Desktop width: no media query matches (`useNarrow` and `prefers-color-scheme` read this).
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
}

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  window.history.replaceState(null, "", "/");
  document.title = "";
});
