import { resolve } from "node:path";
import {
  MODEL_THINKING_LEVELS as THINKING_LEVELS,
  type ModelThinkingLevel as ThinkingLevel,
} from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";

const root = resolve(import.meta.dirname, "../../..");

/** `provider/modelId`; the model ID may hold slashes itself, as OpenRouter's do. */
export function parseModel(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    throw new Error(`MODEL must look like provider/modelId, got "${value}".`);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
  patientDir: resolve(root, process.env.PATIENT_DIR ?? "data/patient-0000-0001"),
  /** The Pi Durable store: screens, contradictions and every model turn survive a restart. */
  storePath: resolve(root, process.env.STORE_PATH ?? ".data/agent.sqlite"),
  /** Subscription tokens from the sign-in, readable by the owner only. */
  credentialsPath: resolve(root, process.env.CREDENTIALS_PATH ?? ".data/credentials.json"),
  deviceIdPath: resolve(root, ".data/device-id"),
  webDist: resolve(root, "apps/web/dist"),
  /** ChatGPT sign-in by default; any pi-ai provider with its API key in .env works too. */
  model: parseModel(process.env.MODEL ?? "openai-codex/gpt-6-luna"),
  /** Reasoning effort per job: screens must be fast, the one-off contradiction scan thorough. */
  screenThinking: thinking(process.env.SCREEN_THINKING, "off"),
  scanThinking: thinking(process.env.SCAN_THINKING, "medium"),
};

function thinking(value: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  if (value === undefined) return fallback;
  if (!(THINKING_LEVELS as readonly string[]).includes(value))
    throw new Error(`Thinking level must be one of ${THINKING_LEVELS.join(", ")}, got "${value}".`);
  return value as ThinkingLevel;
}
