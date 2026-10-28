const KEY = "nexus-theme";
type Theme = "light" | "dark";

/** Applies a saved explicit choice; without one, CSS follows prefers-color-scheme. */
export function applySavedTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode): the system preference still applies.
  }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
}

export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not persisted; the toggle still works for this session.
  }
  return next;
}
