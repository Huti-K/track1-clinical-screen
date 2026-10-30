import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadPatientRecord } from "@track1/patient-record";
import type { AuthStatus } from "@track1/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClinicalRuntime } from "../src/agent/runtime.js";
import { buildApp } from "../src/app.js";
import { FileCredentialStore } from "../src/auth/credentials.js";
import { SubscriptionLogin } from "../src/auth/login.js";

const model = { provider: "openai-codex", modelId: "gpt-6-luna" };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "track1-auth-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("keeps patient data behind the ChatGPT sign-in and closes it again on sign-out", async () => {
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const models = builtinModels({ credentials });
  const runtime = await ClinicalRuntime.open({
    storage: new MemoryStorage(),
    models,
    model,
    record: await loadPatientRecord(join(import.meta.dirname, "fixtures/patient")),
  });
  const login = new SubscriptionLogin({
    models,
    credentials,
    model,
    deviceIdPath: join(directory, "device-id"),
  });
  const app = await buildApp([runtime], { login });
  try {
    expect((await app.inject("/api/patients")).statusCode).toBe(401);
    expect((await app.inject("/api/patients/9999-0001/documents/D1")).statusCode).toBe(401);
    expect((await app.inject("/api/auth")).json<AuthStatus>()).toMatchObject({
      signedIn: false,
      subscription: true,
      providerName: "OpenAI (ChatGPT Plus/Pro)",
    });

    // What a finished ChatGPT sign-in stores.
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    }));
    expect((await app.inject("/api/patients")).statusCode).toBe(200);

    expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(200);
    expect((await app.inject("/api/patients")).statusCode).toBe(401);
  } finally {
    await app.close();
    await runtime.close();
  }
});
