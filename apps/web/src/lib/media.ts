import { useSyncExternalStore } from "react";

// Tailwind 4's default breakpoints, for layout that changes structure (not just styling) with the width.
export const MD = "(min-width: 48rem)";
export const XL = "(min-width: 80rem)";

/** Whether a media query matches, live. Without `matchMedia` (jsdom, old engines) it answers `fallback`. */
export function useMedia(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => window.matchMedia?.(query).matches ?? fallback,
  );
}
