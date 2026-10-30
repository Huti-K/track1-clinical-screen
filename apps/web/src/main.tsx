import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { applyTheme, readStored, THEME_KEY, type ThemePreference } from "./prefs";

applyTheme(readStored<ThemePreference>(THEME_KEY, "light"));

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
