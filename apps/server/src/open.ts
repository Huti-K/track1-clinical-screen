import { mkdirSync } from "node:fs";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadPatientRecords } from "@track1/patient-record";
import { ClinicalRuntime, type RuntimeOptions } from "./agent/runtime.js";
import { FileCredentialStore } from "./auth/credentials.js";
import { SubscriptionLogin } from "./auth/login.js";
import { config, storePathFor } from "./config.js";
import { withServiceTier } from "./service-tier.js";

/**
 * One runtime per patient folder, each with its own SQLite store, on the configured model, and the
 * sign-in for that model: a subscription login (ChatGPT for `openai-codex`) or an API key from the
 * environment.
 */
export async function openConfigured(
  log: (message: string, error?: unknown) => void,
  overrides: Partial<
    Pick<RuntimeOptions, "model" | "backgroundModel" | "thinking" | "retrieval" | "timeoutMs">
  > & {
    /** Each patient's storage instead of its SQLite store, such as a fresh MemoryStorage. */
    storage?: (patientId: string) => Storage;
  } = {},
) {
  const model = overrides.model ?? config.model;
  const records = await loadPatientRecords(config.patientsDir);
  if (records.length === 0)
    throw new Error(`No patient folder with a patient.json in ${config.patientsDir}.`);
  const credentials = new FileCredentialStore(config.credentialsPath);
  const models = withServiceTier(builtinModels({ credentials }), config.serviceTier);
  const { provider, modelId } = model;
  if (!models.getModel(provider, modelId))
    throw new Error(`Unknown model ${provider}/${modelId}. Set MODEL=provider/modelId.`);
  mkdirSync(config.storeDir, { recursive: true });
  const backgroundModel = overrides.backgroundModel ?? config.backgroundModel;
  const runtimes = await Promise.all(
    records.map(async (record) => {
      const { id } = record.summary;
      return ClinicalRuntime.open({
        storage: overrides.storage?.(id) ?? (await openNodeSqliteStorage(storePathFor(id))),
        models,
        model,
        thinking: overrides.thinking ?? {
          screen: config.screenThinking,
          scan: config.scanThinking,
        },
        retrieval: overrides.retrieval ?? config.retrieval,
        ...(backgroundModel ? { backgroundModel } : {}),
        ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
        record,
        log: (message, error) => log(`[${id}] ${message}`, error),
      });
    }),
  );
  const login = new SubscriptionLogin({
    models,
    credentials,
    model,
    deviceIdPath: config.deviceIdPath,
    onSignedIn: () => {
      for (const runtime of runtimes)
        runtime.prepare((message, error) =>
          log(`[${runtime.record.summary.id}] ${message}`, error),
        );
    },
    log,
  });
  return { runtimes, login };
}
