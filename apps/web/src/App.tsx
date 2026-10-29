import type { AuthStatus, PatientSummary, ScreenResponse } from "@track1/shared";
import { ArrowUp } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Badge, Button, ErrorText, formatDate, Spinner } from "./components/ui";
import { DocumentPanel, type DocumentTarget } from "./DocumentPanel";
import { LoginPage } from "./LoginPage";
import { ScreenSkeleton, ScreenView } from "./ScreenView";
import { Sidebar } from "./Sidebar";

const EXAMPLES = [
  "Pre-operative anaesthesia check. You are the anaesthetist. She is scheduled for a hip replacement next week.",
  "Surgery planning after the case conference. You are the surgeon planning her operation.",
  "Diabetes review at the GP. You are her general practitioner (GP), reviewing her diabetes.",
  "Emergency department at night. You are the emergency physician on night duty. She arrives with shortness of breath.",
  "Open follow-ups from the last hospital stay. You are her GP. You check which follow-ups from her last hospital stay are still open.",
];

function Workspace({ auth, onAuth }: { auth: AuthStatus; onAuth: (auth: AuthStatus) => void }) {
  const [patient, setPatient] = useState<PatientSummary>();
  const [situation, setSituation] = useState("");
  const [result, setResult] = useState<ScreenResponse>();
  const [loadMs, setLoadMs] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<DocumentTarget>();

  const signedOut = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) api.auth().then(onAuth, () => {});
      return e instanceof Error ? e.message : String(e);
    },
    [onAuth],
  );

  useEffect(() => {
    api.patient().then(setPatient, (e) => setError(signedOut(e)));
  }, [signedOut]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!situation.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    setOpen(undefined);
    const started = performance.now();
    try {
      setResult(await api.screen(situation));
      setLoadMs(performance.now() - started);
    } catch (e) {
      setError(signedOut(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full bg-chrome">
      <Sidebar
        patient={patient}
        auth={auth}
        openDocumentId={open && !open.passageId ? open.documentId : undefined}
        onOpenDocument={setOpen}
        onSignOut={() => api.logout().then(onAuth, () => {})}
      />
      <main className="flex min-w-0 flex-1 lg:py-3 lg:pr-3">
        <div className="flex min-w-0 flex-1 overflow-hidden bg-surface lg:rounded-2xl">
          <div className="min-w-0 flex-1 overflow-y-auto px-3 py-5 [scrollbar-gutter:stable] sm:px-6">
            <header className="flex flex-col gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">
                {patient?.name ?? <span className="text-shimmer">Loading patient…</span>}
              </h1>
              {patient && (
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                  <span className="capitalize">{patient.sex}</span>·
                  <span>born {formatDate(patient.dateOfBirth)}</span>·
                  <span>
                    {patient.ageAsOf} years on {formatDate(patient.asOf)}
                  </span>
                  <Badge className="ml-1">Latest document {formatDate(patient.asOf)}</Badge>
                </p>
              )}
            </header>

            <form onSubmit={submit} className="mt-6 flex max-w-3xl flex-col gap-3">
              <div className="flex items-end gap-2 rounded-[20px] bg-surface-2 p-2 pl-4 transition-colors duration-150 focus-within:bg-hover/60">
                <textarea
                  aria-label="Your role and task"
                  value={situation}
                  rows={2}
                  placeholder="Who are you and what are you about to do? For example: anaesthetist, pre-operative check before hip surgery"
                  onChange={(e) => setSituation(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  className="min-h-12 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  aria-label="Show my screen"
                  title="Show my screen"
                  disabled={busy || !situation.trim()}
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity duration-150 disabled:cursor-default disabled:opacity-40"
                >
                  {busy ? <Spinner /> : <ArrowUp className="size-4" />}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-2xs text-muted-foreground">Try</span>
                {EXAMPLES.map((example) => (
                  <Button
                    key={example}
                    variant="secondary"
                    size="sm"
                    className="h-7 rounded-full font-normal text-muted-foreground"
                    onClick={() => setSituation(example)}
                  >
                    {example.split(".")[0]}
                  </Button>
                ))}
              </div>
            </form>

            <div className="mt-10 pb-10">
              {error && <ErrorText title="The screen could not be built." reason={error} />}
              {busy && <ScreenSkeleton documents={patient?.documents.length ?? 8} />}
              {!busy && result && (
                <ScreenView result={result} loadMs={loadMs} open={open} onOpen={setOpen} />
              )}
            </div>
          </div>
          {open && <DocumentPanel target={open} onClose={() => setOpen(undefined)} />}
        </div>
      </main>
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
