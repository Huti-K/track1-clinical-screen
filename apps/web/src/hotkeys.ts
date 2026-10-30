import { useEffect, useRef } from "react";

type Shortcut = {
  /** Matched by physical key where Shift changes the character, else by the typed key. */
  code?: string;
  key?: string;
  shift?: boolean;
  /** The key as the app shows it, after the modifiers. */
  label: string;
  description: string;
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** ⌘ or Ctrl plus these; their order is the shortcuts dialog's. */
export const SHORTCUTS = {
  newScreen: { code: "KeyO", shift: true, label: "O", description: "New screen" },
  sidebar: { code: "KeyS", shift: true, label: "S", description: "Show or hide the sidebar" },
  palette: { code: "KeyK", label: "K", description: "Go to a screen, document or setting" },
  settings: { key: ",", label: ",", description: "Settings" },
  shortcuts: { key: "/", label: "/", description: "Keyboard shortcuts" },
} satisfies Record<string, Shortcut>;

/** The keys to press, as this platform names them: ⌘ ⇧ O on a Mac, Ctrl Shift O elsewhere. */
export function keysOf(shortcut: Shortcut): string[] {
  return [
    IS_MAC ? "⌘" : "Ctrl",
    ...(shortcut.shift ? [IS_MAC ? "⇧" : "Shift"] : []),
    shortcut.label,
  ];
}

function matches(shortcut: Shortcut, event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || (shortcut.shift && !event.shiftKey)) return false;
  return shortcut.code ? event.code === shortcut.code : event.key.toLowerCase() === shortcut.key;
}

/** Runs the latest handler on every keydown that reaches the window. */
export function useKeydown(handler: (event: KeyboardEvent) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => latest.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Runs the handler on the app-wide shortcut, in text fields too. */
export function useHotkey(shortcut: Shortcut, handler: () => void): void {
  useKeydown((event) => {
    if (!matches(shortcut, event)) return;
    event.preventDefault();
    handler();
  });
}
