import type {
  AuthStatus,
  Contradiction,
  Note,
  PatientSummary,
  ScreenResponse,
} from "@track1/shared";
import { Menu } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { ComparePanel } from "./ComparePanel";
import { Brand } from "./components/BrandMark";
import { Button, ErrorText, Spinner } from "./components/ui";
import { DocumentPanel, type DocumentTarget } from "./DocumentPanel";
import { SHORTCUTS, useHotkey, useKeydown } from "./hotkeys";
import { LoginPage } from "./LoginPage";
import {
  SCREENS_KEY,
  SIDEBAR_KEY,
  THEME_KEY,
  type ThemePreference,
  useResolvedTheme,
  useStored,
} from "./prefs";
import { asRole, ScenarioForm } from "./ScenarioForm";
import { layoutScreen, ScreenSkeleton, ScreenView } from "./ScreenView";
import { SettingsPage, type SettingsSectionId, settingsSectionOf } from "./SettingsPage";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { type ScreenEntry, Sidebar, SidebarFrame, type SidebarProps } from "./Sidebar";

/** The situation is kept so a saved screen can be asked for again; the server answers from its cache. */
type SavedScreen = ScreenEntry & { situation: string };
const MAX_SAVED = 30;

const screenPath = (id?: string) => (id ? `/screens/${encodeURIComponent(id)}` : "/");
const settingsPath = (section: SettingsSectionId) => `/settings/${section}`;

function screenIdOf(path: string): string | undefined {
  const id = path.match(/^\/screens\/([^/]+)\/?$/)?.[1];
  return id && decodeURIComponent(id);
}

function Workspace({ auth, onAuth }: { auth: AuthStatus; onAuth: (auth: AuthStatus) => void }) {
  const [patient, setPatient] = useState<PatientSummary>();
  const [situation, setSituation] = useState("");
  const [result, setResult] = useState<ScreenResponse>();
  const [saved, setSaved] = useStored<SavedScreen[]>(SCREENS_KEY, []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [letter, setLetterTarget] = useState<DocumentTarget>();
  const [comparing, setComparing] = useState<Contradiction>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [themePreference, setThemePreference] = useStored<ThemePreference>(THEME_KEY, "light");
  useResolvedTheme(themePreference);
  const [collapsed, setCollapsed] = useStored(SIDEBAR_KEY, false);
  const [drawer, setDrawer] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [palette, setPalette] = useState(false);
  /** The settings section on display, instead of a screen. */
  const [settings, setSettings] = useState<SettingsSectionId>();
  /** Screens fetched since the page loaded, so back and forward need no request. */
  const loaded = useRef(new Map<string, ScreenResponse>());
  const pending = useRef<AbortController>(undefined);

  const layout = useMemo(() => (result ? layoutScreen(result) : undefined), [result]);

  const setLetter = useCallback((target: DocumentTarget | undefined) => {
    setComparing(undefined);
    setLetterTarget(target);
  }, []);

  const signedOut = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) api.auth().then(onAuth, () => {});
      return e instanceof Error ? e.message : String(e);
    },
    [onAuth],
  );

  useEffect(() => {
    api.patient().then(setPatient, (e) => setError(signedOut(e)));
    api.notes().then(setNotes, () => {});
  }, [signedOut]);

  function display(next: ScreenResponse) {
    setResult(next);
    setLetter(undefined);
  }

  function stop() {
    pending.current?.abort();
    pending.current = undefined;
    setBusy(false);
  }

  /** Stops waiting; the server still finishes and keeps the screen for the next request. */
  function cancel() {
    stop();
    if (!result) window.history.replaceState(null, "", "/");
  }

  async function build(text: string, replace = false) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.screen(text, controller.signal);
      loaded.current.set(next.id, next);
      setSaved((list) =>
        [
          {
            id: next.id,
            role: next.screen.role,
            task: next.screen.task,
            situation: text,
            savedAt: new Date().toISOString(),
          },
          ...list.filter((s) => s.id !== next.id),
        ].slice(0, MAX_SAVED),
      );
      const path = screenPath(next.id);
      if (path !== window.location.pathname)
        window.history[replace ? "replaceState" : "pushState"](null, "", path);
      display(next);
    } catch (e) {
      if (!controller.signal.aborted) setError(signedOut(e));
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setBusy(false);
      }
    }
  }

  /** Shows what the address names: the start page, one saved screen or a settings section. */
  function route() {
    const { pathname } = window.location;
    const id = screenIdOf(pathname);
    const section = settingsSectionOf(pathname);
    setDrawer(false);
    setError(undefined);
    setLetter(undefined);
    setSettings(section);
    if (section) {
      // Waiting for a screen would carry the user off this page when it lands.
      stop();
      if (pathname !== settingsPath(section))
        window.history.replaceState(null, "", settingsPath(section));
      return;
    }
    const ready = id ? loaded.current.get(id) : undefined;
    if (ready) {
      stop();
      display(ready);
      return;
    }
    setResult(undefined);
    const entry = id ? saved.find((s) => s.id === id) : undefined;
    setSituation(entry?.situation ?? "");
    if (entry) {
      void build(entry.situation, true);
      return;
    }
    stop();
    if (id) window.history.replaceState(null, "", "/");
  }
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const onPop = () => routeRef.current();
    onPop();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function go(path: string) {
    if (path !== window.location.pathname) window.history.pushState(null, "", path);
    route();
  }
  const navigate = (id?: string) => go(screenPath(id));
  const openSettings = (section: SettingsSectionId = "general") => go(settingsPath(section));

  function submit(event?: FormEvent, text = situation) {
    event?.preventDefault();
    if (text.trim() && !busy) void build(text);
  }

  const showResult = result && layout && !busy && !settings;
  const title = settings ? "Settings" : showResult ? result.screen.task : undefined;
  useEffect(() => {
    document.title = title ? `${title} · Clinical screen` : "Clinical screen";
  }, [title]);

  const toggleSidebar = () =>
    window.matchMedia("(min-width: 1024px)").matches
      ? setCollapsed((c) => !c)
      : setDrawer((d) => !d);
  useHotkey(SHORTCUTS.newScreen, () => navigate());
  useHotkey(SHORTCUTS.sidebar, toggleSidebar);
  useHotkey(SHORTCUTS.palette, () => setPalette((open) => !open));
  useHotkey(SHORTCUTS.settings, () => openSettings());
  useHotkey(SHORTCUTS.shortcuts, () => setShortcuts(true));
  // Popovers, menus and the search field take their Escape first and mark it handled.
  useKeydown((e) => {
    if (e.key !== "Escape" || e.defaultPrevented || shortcuts || palette) return;
    if (drawer) setDrawer(false);
    else if (letter || comparing) setLetter(undefined);
  });

  const onSignOut = () => api.logout().then(onAuth, () => {});
  const removeNote = (id: string) => {
    setNotes((list) => list.filter((n) => n.id !== id));
    api.removeNote(id).catch(() => api.notes().then(setNotes, () => {}));
  };
  const nav: Omit<SidebarProps, "mode" | "onToggle"> = {
    patient,
    auth,
    screens: saved,
    currentScreenId: showResult ? result.id : undefined,
    screen: showResult ? result : undefined,
    documentId: letter?.documentId,
    onHome: () => navigate(),
    onScreen: navigate,
    onRemoveScreen: (id) => setSaved((list) => list.filter((s) => s.id !== id)),
    onDocument: (d) => {
      setDrawer(false);
      setLetter({ documentId: d.id, documentTitle: d.title });
    },
    onShortcuts: () => {
      setDrawer(false);
      setShortcuts(true);
    },
    onSettings: () => openSettings(),
    onSignOut,
  };

  return (
    <div className="flex h-full bg-chrome">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-foreground"
      >
        Skip to the screen
      </a>
      <SidebarFrame {...nav} collapsed={collapsed} onCollapsed={setCollapsed} />
      {drawer && (
        <div className="lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="ui-fade-in fixed inset-0 z-40 cursor-default bg-black/20 backdrop-blur-[2px]"
          />
          <div className="ui-slide-in fixed inset-y-0 left-0 z-50 flex w-[min(18rem,calc(100vw-2.5rem))] bg-chrome">
            <Sidebar {...nav} mode="drawer" onToggle={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <main id="main" className="flex min-w-0 flex-1 flex-col bg-surface lg:bg-transparent lg:py-3">
        <header className="flex items-center gap-1 px-2 pt-2 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu className="size-4" />
          </Button>
          <button
            type="button"
            onClick={() => navigate()}
            title="Home · new screen"
            className="cursor-pointer rounded-[10px] px-1.5 py-1"
          >
            <Brand />
          </button>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface lg:mr-3 lg:rounded-2xl">
          {/* A screen lays out and scrolls its own columns; the other pages scroll as one. */}
          <div
            className={`@container min-w-0 flex-1 overflow-y-auto ${showResult ? "" : "px-4 py-8 [scrollbar-gutter:stable] sm:px-10 lg:px-14"}`}
          >
            <div
              className={
                showResult
                  ? "flex flex-col @4xl:h-full"
                  : `mx-auto ${settings ? "max-w-[880px] lg:pt-6" : "max-w-[720px] lg:pt-6"}`
              }
            >
              {error && !settings && (
                <div className={showResult ? "px-4 pt-8 sm:px-10 lg:px-14" : "mb-6"}>
                  <ErrorText
                    title="The screen could not be built."
                    reason={error}
                    action={
                      situation.trim() && !busy ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3"
                          onClick={() => submit()}
                        >
                          Try again
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              )}
              {settings ? (
                <SettingsPage
                  section={settings}
                  onSection={openSettings}
                  auth={auth}
                  theme={themePreference}
                  onTheme={setThemePreference}
                  sidebarFolded={collapsed}
                  onSidebarFolded={setCollapsed}
                  screens={saved}
                  onClearScreens={() => setSaved([])}
                  notes={notes}
                  onRemoveNote={removeNote}
                  onSignOut={onSignOut}
                />
              ) : showResult ? (
                <ScreenView
                  key={result.id}
                  result={result}
                  layout={layout}
                  onOpenLetter={setLetter}
                  onCompare={(c) => {
                    setLetterTarget(undefined);
                    setComparing(c);
                  }}
                  onRole={(role) => {
                    const text = asRole(result.screen.situation, role);
                    setSituation(text);
                    submit(undefined, text);
                  }}
                  notes={notes}
                  onAddNote={async (input) => {
                    const note = await api.addNote(input);
                    setNotes((list) => [...list, note]);
                  }}
                  onRemoveNote={removeNote}
                />
              ) : (
                <>
                  <ScenarioForm
                    patient={patient}
                    situation={situation}
                    busy={busy}
                    onChange={setSituation}
                    onSubmit={submit}
                    onCancel={cancel}
                  />
                  {busy && (
                    <div className="mt-10">
                      <ScreenSkeleton documents={patient?.documents.length ?? 8} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          {letter && <DocumentPanel target={letter} onClose={() => setLetter(undefined)} />}
          {comparing && result && (
            <ComparePanel
              contradiction={comparing}
              passages={result.passages ?? {}}
              onOpen={setLetter}
              onClose={() => setComparing(undefined)}
            />
          )}
        </div>
      </main>
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        screens={saved}
        documents={patient?.documents ?? []}
        onNewScreen={() => navigate()}
        onScreen={navigate}
        onDocument={(d) => {
          if (settings) navigate(result?.id);
          setLetter({ documentId: d.id, documentTitle: d.title });
        }}
        onSettings={openSettings}
      />
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.auth().then(setAuth, (e: Error) => setError(e.message));
  }, []);

  if (error)
    return (
      <div className="p-6">
        <ErrorText title="The server is not reachable." reason={error} />
      </div>
    );
  if (!auth)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  return auth.signedIn ? (
    <Workspace auth={auth} onAuth={setAuth} />
  ) : (
    <LoginPage status={auth} onChange={setAuth} />
  );
}
