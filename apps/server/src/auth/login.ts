import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthEvent, AuthPrompt, CredentialStore, Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AuthStatus, LoginStep } from "@track1/shared";
import { HttpError } from "../agent/runtime.js";

interface Flow {
  step: LoginStep;
  pendingInput?: (value: string) => void;
  abort: AbortController;
}

export interface LoginOptions {
  models: Models;
  credentials: CredentialStore;
  model: ModelRef;
  /** OpenAI's ChatGPT sign-in identifies the installation by this ID and expects it to stay the same. */
  deviceIdPath: string;
  onSignedIn?: () => void;
  log?: (message: string, error?: unknown) => void;
}

/** The ChatGPT account in an OpenAI access token, for the account row; never trusted for anything else. */
function accountOf(access: unknown): string | undefined {
  if (typeof access !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
    const email = payload?.["https://api.openai.com/profile"]?.email ?? payload?.email;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signs the configured provider in with its subscription login, such as ChatGPT for `openai-codex`,
 * the way Marlene's settings do. One flow at a time; the web app polls `status()` while it runs.
 */
export class SubscriptionLogin {
  #flow: Flow | null = null;

  constructor(private readonly options: LoginOptions) {}

  get #oauth() {
    return this.options.models.getProvider(this.options.model.provider)?.auth.oauth;
  }

  async signedIn(): Promise<boolean> {
    const { provider, modelId } = this.options.model;
    const model = this.options.models.getModel(provider, modelId);
    if (!model) return false;
    try {
      return (await this.options.models.getAuth(model)) !== undefined;
    } catch {
      // A refresh the provider refused counts as signed out.
      return false;
    }
  }

  async status(): Promise<AuthStatus> {
    const { provider, modelId } = this.options.model;
    const oauth = this.#oauth;
    const stored = await this.options.credentials.read(provider);
    const account = stored?.type === "oauth" ? accountOf(stored.access) : undefined;
    return {
      signedIn: await this.signedIn(),
      providerName: oauth?.name ?? provider,
      model: `${provider}/${modelId}`,
      subscription: Boolean(oauth),
      ...(account ? { account } : {}),
      stored: stored !== undefined,
      login: this.#flow ? { ...this.#flow.step } : null,
    };
  }

  async #deviceId(): Promise<string> {
    try {
      return (await readFile(this.options.deviceIdPath, "utf8")).trim();
    } catch {
      const id = randomUUID();
      await mkdir(dirname(this.options.deviceIdPath), { recursive: true });
      await writeFile(this.options.deviceIdPath, id);
      return id;
    }
  }

  /** Resolves once the flow needs the user (a sign-in page, a code, a pasted URL) or has ended. */
  async start(method: "browser" | "device"): Promise<AuthStatus> {
    const oauth = this.#oauth;
    if (!oauth)
      throw new HttpError(400, `${this.options.model.provider} signs in with an API key in .env.`);
    this.cancel();
    const installation = await this.#deviceId();
    const abort = new AbortController();
    const flow: Flow = { step: { done: false }, abort };
    this.#flow = flow;
    let reachedUser: () => void = () => {};
    const userStep = new Promise<void>((resolve) => {
      reachedUser = resolve;
    });

    const prompt = async (request: AuthPrompt): Promise<string> => {
      if (request.type === "select") {
        // Browser login comes first and the headless device code last.
        const option = method === "browser" ? request.options[0] : request.options.at(-1);
        if (!option) throw new Error(request.message);
        return option.id;
      }
      flow.step.prompt = {
        message: request.message,
        ...(request.placeholder ? { placeholder: request.placeholder } : {}),
      };
      reachedUser();
      return new Promise<string>((resolve, reject) => {
        flow.pendingInput = resolve;
        abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    };

    const notify = (event: AuthEvent): void => {
      if (event.type === "auth_url") flow.step.authUrl = event.url;
      else if (event.type === "device_code")
        flow.step.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
      else return;
      reachedUser();
    };

    oauth
      .login(
        { signal: abort.signal, prompt, notify },
        { getDeviceId: () => installation, agentName: "Roter Faden" },
      )
      .then(async (credential) => {
        await this.options.credentials.modify(this.options.model.provider, async () => credential);
        flow.step = { done: true };
        this.options.onSignedIn?.();
      })
      .catch((error: unknown) => {
        flow.step = {
          done: true,
          error: abort.signal.aborted
            ? "Sign-in cancelled."
            : error instanceof Error
              ? error.message
              : String(error),
        };
        if (!abort.signal.aborted) this.options.log?.("sign-in failed", error);
      })
      .finally(reachedUser);

    await userStep;
    return this.status();
  }

  /** Answers the flow's prompt, such as a redirect URL pasted when the browser callback could not reach us. */
  input(value: string): void {
    const flow = this.#flow;
    if (!flow?.pendingInput || flow.step.done)
      throw new HttpError(409, "No sign-in step is waiting for input.");
    const resolve = flow.pendingInput;
    flow.pendingInput = undefined;
    delete flow.step.prompt;
    resolve(value);
  }

  cancel(): void {
    if (this.#flow && !this.#flow.step.done) this.#flow.abort.abort();
    this.#flow = null;
  }

  async logout(): Promise<void> {
    this.cancel();
    await this.options.credentials.delete(this.options.model.provider);
  }
}
