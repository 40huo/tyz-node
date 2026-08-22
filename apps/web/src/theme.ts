import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "tyz-theme";

export type Theme = "light" | "dark";

function readInitial(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// 模块级单例：顶栏与个人中心等多个消费方共享同一份主题状态，任一处切换全站同步
// （首帧的 class/data-theme 由 index.html 的预绘脚本落好，这里只在变更时接管）。
let current: Theme = readInitial();
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  for (const listener of listeners) listener();
}

/** Light/dark theme on <html class="dark" data-theme="…"> (HeroUI v3 convention), persisted to localStorage. */
export function useTheme() {
  const theme = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
  );
  const setTheme = useCallback((t: Theme) => apply(t), []);
  const toggle = useCallback(() => apply(current === "dark" ? "light" : "dark"), []);
  return { theme, setTheme, toggle };
}
