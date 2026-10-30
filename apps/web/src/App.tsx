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
import { PatientContext } from "./patient";
import {
  PATIENT_KEY,
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
type SavedScreen = ScreenEntry & {
  situation: string;
  /** The patient it was built for; screens saved before there were several patients have none. */
  patientId?: string;
};
const MAX_SAVED = 30;

const patientPath = (patientId: string) => `/patients/${encodeURIComponent(patientId)}`;
const screenPath = (patientId: string, id?: string) =>
  id ? `${patientPath(patientId)}/screens/${encodeURIComponent(id)}` : patientPath(patientId);
const settingsPath = (section: SettingsSectionId) => `/settings/${section}`;

/** The patient and the screen an address names, such as `/patients/0000-0002/screens/1f3a`. */
function placeOf(path: string): { patientId?: string; screenId?: string } {
  const [, patientId, screenId] =
    path.match(/^\/patients\/([^/]+)(?:\/screens\/([^/]+))?\/?$/) ?? [];
  return {
    patientId: patientId && decodeURIComponent(patientId),
    screenId: screenId && decodeURIComponent(screenId),
  };
}

function Workspace({ auth, onAuth }: { auth: AuthStatus; onAuth: (auth: AuthStatus) => void }) {
  const [patients, setPatients] = useState<PatientSummary[]>();
  const [patient, setPatient] = useState<PatientSummary>();
  const [lastPatient, setLastPatient] = useStored(PATIENT_KEY, "");
  /** The patient on display now, for answers that arrive after a switch to another patient. */
  const shownPatient = useRef<string>(undefined);
  shownPatient.current = patient?.id;
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
    api.patients().then(setPatients, (e) => setError(signedOut(e)));
  }, [signedOut]);

  // Only this patient's notes; a list that arrives after a switch to another patient is dropped.
  const patientId = patient?.id;
  useEffect(() => {
    setNotes([]);
    if (!patientId) return;
    let current = true;
    api.notes(patientId).then(
      (list) => {
        if (current) setNotes(list);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [patientId]);

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
    if (!result && patient) window.history.replaceState(null, "", screenPath(patient.id));
  }

  async function build(owner: PatientSummary, text: string, replace = false) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.screen(owner.id, text, controller.signal);
      loaded.current.set(next.id, next);
      setSaved((list) =>
        [
          {
            id: next.id,
            patientId: owner.id,
            role: next.screen.role,
            task: next.screen.task,
            situation: text,
            savedAt: new Date().toISOString(),
          },
          ...list.filter((s) => s.id !== next.id),
        ].slice(0, MAX_SAVED),
      );
      const path = screenPath(owner.id, next.id);
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

  /**
   * Shows what the address names: a patient's start page or one of their saved screens, or a
   * settings section. Without a patient in the address it shows the patient picked last.
   */
  function route() {
    const { pathname } = window.location;
    const section = settingsSectionOf(pathname);
    const place = placeOf(pathname);
    const list = patients ?? [];
    const shown =
      list.find((p) => p.id === place.patientId) ??
      list.find((p) => p.id === (patient?.id ?? lastPatient)) ??
      list[0];
    setDrawer(false);
    setError(undefined);
    setLetter(undefined);
    setSettings(section);
    if (shown && shown.id !== patient?.id) {
      setPatient(shown);
      setLastPatient(shown.id);
    }
    if (section) {
      // Waiting for a screen would carry the user off this page when it lands.
      stop();
      if (pathname !== settingsPath(section))
        window.history.replaceState(null, "", settingsPath(section));
      return;
    }
    if (!shown) return;
    const id = shown.id === place.patientId ? place.screenId : undefined;
    const ready = id ? loaded.current.get(id) : undefined;
    if (ready?.patient.id === shown.id) {
      stop();
      display(ready);
      return;
    }
    setResult(undefined);
    const entry = id ? saved.find((s) => s.id === id && s.patientId === shown.id) : undefined;
    setSituation(entry?.situation ?? "");
    if (entry) {
      void build(shown, entry.situation, true);
      return;
    }
    stop();
    if (pathname !== screenPath(shown.id))
      window.history.replaceState(null, "", screenPath(shown.id));
  }
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    if (!patients) return;
    const onPop = () => routeRef.current();
    onPop();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [patients]);

  function go(path: string) {
    if (path !== window.location.pathname) window.history.pushState(null, "", path);
    route();
  }
  const navigate = (id?: string) => {
    if (patient) go(screenPath(patient.id, id));
  };
  const openSettings = (section: SettingsSectionId = "general") => go(settingsPath(section));

  function submit(event?: FormEvent, text = situation) {
    event?.preventDefault();
    if (text.trim() && !busy && patient) void build(patient, text);
  }

  const showResult = result && layout && !busy && !settings;
  const title = settings ? "Settings" : showResult ? result.screen.task : undefined;
  const patientName = patient?.name;
  useEffect(() => {
    document.title = [title, patientName, "Clinical screen"].filter(Boolean).join(" · ");
  }, [title, patientName]);

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
    if (!patient) return;
    const owner = patient.id;
    setNotes((list) => list.filter((n) => n.id !== id));
    api.removeNote(owner, id).catch(() =>
      api.notes(owner).then(
        (list) => {
          if (shownPatient.current === owner) setNotes(list);
        },
        () => {},
      ),
    );
  };
  /** Only the screens built for this patient. */
  const screens = saved.filter((s) => s.patientId === patient?.id);
  const nav: Omit<SidebarProps, "mode" | "onToggle"> = {
    patient,
    patients: patients ?? [],
    onPatient: (p) => go(patientPath(p.id)),
    auth,
    screens,
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
    <PatientContext.Provider value={patient?.id}>
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
        <main
          id="main"
          className="flex min-w-0 flex-1 flex-col bg-surface lg:bg-transparent lg:py-3"
        >
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
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface lg:mr-3 lg:rounded-xl lg:border lg:border-border lg:shadow-sm">
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
                    screens={screens}
                    onClearScreens={() =>
                      setSaved((list) => list.filter((s) => s.patientId !== patient?.id))
                    }
                    notes={notes}
                    onRemoveNote={removeNote}
                    onSignOut={onSignOut}
                  />
                ) : showResult ? (
                  <ScreenView
                    key={result.id}
                    result={result}
                    layout={layout}
                    letterOpen={!!letter}
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
                      const owner = result.patient.id;
                      const note = await api.addNote(owner, input);
                      if (shownPatient.current === owner) setNotes((list) => [...list, note]);
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
          screens={screens}
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
    </PatientContext.Provider>
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
