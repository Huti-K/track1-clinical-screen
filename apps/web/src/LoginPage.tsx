import type { AuthStatus } from "@track1/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { BrandMark } from "./components/BrandMark";
import { Button, ErrorText, Spinner } from "./components/ui";

/**
 * Sign-in with the ChatGPT subscription through OpenAI's Codex login. The browser login returns to
 * a local callback; the code login works when that callback is taken.
 */
export function LoginPage({
  status,
  onChange,
}: {
  status: AuthStatus;
  onChange: (status: AuthStatus) => void;
}) {
  const [busy, setBusy] = useState<"browser" | "device">();
  const [failure, setFailure] = useState<string>();
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);
  const step = status.login;
  const waiting = Boolean(step && !step.done);

  // The flow finishes in another tab; poll until the server has the tokens.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      api.auth().then(onChange, () => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [waiting, onChange]);

  async function start(method: "browser" | "device") {
    setFailure(undefined);
    setBusy(method);
    // Opened inside the click, so the browser lets it through; pointed at the page once known.
    const tab = method === "browser" ? window.open("about:blank", "_blank") : null;
    try {
      const next = await api.login(method);
      if (tab && next.login?.authUrl) tab.location.href = next.login.authUrl;
      else tab?.close();
      onChange(next);
    } catch (error) {
      tab?.close();
      setFailure((error as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function submitPasted(event: FormEvent) {
    event.preventDefault();
    try {
      onChange(await api.loginInput(pasted.trim()));
      setPasted("");
    } catch (error) {
      setFailure((error as Error).message);
    }
  }

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const error = failure ?? step?.error;

  return (
    <div className="flex min-h-full items-center justify-center bg-chrome p-6">
      <div className="ui-enter-up flex w-full max-w-sm flex-col gap-6 rounded-2xl bg-surface p-8">
        <div className="flex flex-col gap-4">
          <BrandMark size={40} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in to Roter Faden</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {status.subscription
                ? `Uses your ${status.providerName} account${status.model.startsWith("openai-codex/") ? ", as the Codex CLI does. Codex stays signed in." : "."}`
                : `${status.model} signs in with an API key. Add it to .env and restart the server.`}
            </p>
          </div>
        </div>

        {status.subscription && !waiting && (
          <div className="flex flex-col gap-2">
            <Button loading={busy === "browser"} onClick={() => start("browser")}>
              Continue with ChatGPT
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="self-center text-muted-foreground"
              loading={busy === "device"}
              onClick={() => start("device")}
            >
              Sign in with a code instead
            </Button>
          </div>
        )}

        {waiting && step?.deviceCode && (
          <div className="ui-enter-up flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Open the OpenAI page and enter this code.
            </p>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-4 py-3">
              <span className="font-mono text-xl tracking-[0.2em] tabular-nums">
                {step.deviceCode.userCode}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={() => step.deviceCode && copyCode(step.deviceCode.userCode)}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <a
              href={step.deviceCode.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
            >
              Open the OpenAI page <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}

        {waiting && step?.authUrl && !step.deviceCode && (
          <div className="ui-enter-up flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Finish signing in in the ChatGPT tab. This page continues on its own.
            </p>
            <a
              href={step.authUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
            >
              Open the ChatGPT sign-in again <ExternalLink className="size-3.5" />
            </a>
            {step.prompt && (
              <form onSubmit={submitPasted} className="flex flex-col gap-2">
                <label htmlFor="redirect" className="text-xs text-muted-foreground">
                  If the tab ends on an error page, paste its address here.
                </label>
                <input
                  id="redirect"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={step.prompt.placeholder}
                  className="h-9 rounded-lg bg-surface-2 px-3 text-sm outline-none focus:bg-surface focus-visible:shadow-[0_0_0_2px_var(--accent-text)]"
                />
                <Button type="submit" variant="secondary" size="sm" disabled={!pasted.trim()}>
                  Continue
                </Button>
              </form>
            )}
          </div>
        )}

        {waiting && (
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 text-sm">
              <Spinner className="text-muted-foreground" />
              <span className="text-shimmer">Waiting for ChatGPT…</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => api.cancelLogin().then(onChange, () => {})}
            >
              Cancel
            </Button>
          </div>
        )}

        {error && (
          <ErrorText
            title="Signing in did not work."
            reason={error}
            action={
              <Button variant="ghost" size="sm" className="-ml-3" onClick={() => start("browser")}>
                Try again
              </Button>
            }
          />
        )}

        <p className="text-2xs text-muted-foreground">
          Model <span className="font-mono">{status.model}</span>. Tokens stay on this machine in
          .data/credentials.json.
        </p>
      </div>
    </div>
  );
}
