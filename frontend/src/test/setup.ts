import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // A planned trip writes its share link into the URL and its template into recent trips;
  // the next test must start from a fresh page.
  if (typeof window !== "undefined") {
    window.history.replaceState(null, "", "/");
    try {
      window.localStorage.clear();
    } catch {
      // jsdom without storage: nothing to reset.
    }
  }
});

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom does not implement element scrolling.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => undefined;
}
