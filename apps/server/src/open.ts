import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadPatientRecord } from "@track1/patient-record";
import { ClinicalRuntime } from "./agent/runtime.js";
import { FileCredentialStore } from "./auth/credentials.js";
import { SubscriptionLogin } from "./auth/login.js";
import { config } from "./config.js";

/**
 * The runtime on the configured patient folder, SQLite store and model, and the sign-in for that
 * model: a subscription login (ChatGPT for `openai-codex`) or an API key from the environment.
 */
export async function openConfigured(log: (message: string, error?: unknown) => void) {
  const record = await loadPatientRecord(config.patientDir);
  const credentials = new FileCredentialStore(config.credentialsPath);
  const models = builtinModels({ credentials });
  const { provider, modelId } = config.model;
  if (!models.getModel(provider, modelId))
    throw new Error(`Unknown model ${provider}/${modelId}. Set MODEL=provider/modelId.`);
  mkdirSync(dirname(config.storePath), { recursive: true });
  const storage = await openNodeSqliteStorage(config.storePath);
  const runtime = await ClinicalRuntime.open({
    storage,
    models,
    model: config.model,
    thinking: { screen: config.screenThinking, scan: config.scanThinking },
    record,
    log,
  });
  const login = new SubscriptionLogin({
    models,
    credentials,
    model: config.model,
    deviceIdPath: config.deviceIdPath,
    // Found once per store, in the background, so the first screen rarely waits for it.
    onSignedIn: () => void runtime.contradictions().catch((error) => log("scan failed", error)),
    log,
  });
  return { runtime, login };
}
