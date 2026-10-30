import { useEffect, useState } from "react";

/** What the page is drawn in. */
export type Theme = "light" | "dark";
/** What the user picked; `system` follows the operating system. */
export type ThemePreference = Theme | "system";

export const THEME_KEY = "clinical-screen:theme";
export const SIDEBAR_KEY = "clinical-screen:sidebar-collapsed";
export const SCREENS_KEY = "clinical-screen:screens";
/** The patient picked last, shown again on the next visit. */
export const PATIENT_KEY = "clinical-screen:patient";
export const SIDEBAR_WIDTH_KEY = "clinical-screen:sidebar-width";
export const DETAIL_WIDTH_KEY = "clinical-screen:detail-width";
export const DOCUMENT_PANE_KEY = "clinical-screen:document-pane";
export const COMPARE_PANE_KEY = "clinical-screen:compare-pane";
/** The follow-up questions asked on one screen, with their answers. */
export const answersKey = (screenId: string) => `clinical-screen:answers:${screenId}`;

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** State this browser keeps across reloads. */
export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== "system") return preference;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", resolveTheme(preference) === "dark");
}

/** The theme on screen, redrawn when the preference or, under `system`, the OS setting changes. */
export function useResolvedTheme(preference: ThemePreference): Theme {
  const [theme, setTheme] = useState(() => resolveTheme(preference));
  useEffect(() => {
    const update = () => {
      applyTheme(preference);
      setTheme(resolveTheme(preference));
    };
    update();
    if (preference !== "system") return;
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return theme;
}
