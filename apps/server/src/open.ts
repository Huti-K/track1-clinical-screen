import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadPatientRecord } from "@track1/patient-record";
import { ClinicalRuntime, type RuntimeOptions } from "./agent/runtime.js";
import { FileCredentialStore } from "./auth/credentials.js";
import { SubscriptionLogin } from "./auth/login.js";
import { config } from "./config.js";

/**
 * The runtime on the configured patient folder, SQLite store and model, and the sign-in for that
 * model: a subscription login (ChatGPT for `openai-codex`) or an API key from the environment.
 */
export async function openConfigured(
  log: (message: string, error?: unknown) => void,
  overrides: Partial<
    Pick<
      RuntimeOptions,
      "model" | "backgroundModel" | "thinking" | "retrieval" | "storage" | "timeoutMs"
    >
  > = {},
) {
  const model = overrides.model ?? config.model;
  const record = await loadPatientRecord(config.patientDir);
  const credentials = new FileCredentialStore(config.credentialsPath);
  const models = builtinModels({ credentials });
  const { provider, modelId } = model;
  if (!models.getModel(provider, modelId))
    throw new Error(`Unknown model ${provider}/${modelId}. Set MODEL=provider/modelId.`);
  mkdirSync(dirname(config.storePath), { recursive: true });
  const storage = overrides.storage ?? (await openNodeSqliteStorage(config.storePath));
  const runtime = await ClinicalRuntime.open({
    storage,
    models,
    model,
    thinking: overrides.thinking ?? { screen: config.screenThinking, scan: config.scanThinking },
    retrieval: overrides.retrieval ?? config.retrieval,
    ...((overrides.backgroundModel ?? config.backgroundModel)
      ? { backgroundModel: overrides.backgroundModel ?? config.backgroundModel }
      : {}),
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    record,
    log,
  });
  const login = new SubscriptionLogin({
    models,
    credentials,
    model,
    deviceIdPath: config.deviceIdPath,
    onSignedIn: () => runtime.prepare(log),
    log,
  });
  return { runtime, login };
}
