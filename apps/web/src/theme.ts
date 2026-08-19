import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tyz-theme";

function readInitial(): "light" | "dark" {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light/dark theme on <html class="dark" data-theme="…"> (HeroUI v3 convention), persisted to localStorage. */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(readInitial);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}
