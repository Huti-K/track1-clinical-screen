import { join, resolve } from "node:path";
import {
  MODEL_THINKING_LEVELS as THINKING_LEVELS,
  type ModelThinkingLevel as ThinkingLevel,
} from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Retrieval } from "./agent/clinical.js";
import type { ServiceTier } from "./service-tier.js";

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
  /** Every folder in it with a `patient.json` is one patient, such as `data/patient-0000-0001`. */
  patientsDir: resolve(root, process.env.PATIENTS_DIR ?? "data"),
  /** The Pi Durable stores, one per patient: screens, contradictions and every model turn survive a restart. */
  storeDir: resolve(root, process.env.STORE_DIR ?? ".data"),
  /** Subscription tokens from the sign-in, readable by the owner only. */
  credentialsPath: resolve(root, process.env.CREDENTIALS_PATH ?? ".data/credentials.json"),
  deviceIdPath: resolve(root, ".data/device-id"),
  webDist: resolve(root, "apps/web/dist"),
  /** ChatGPT sign-in by default; any pi-ai provider with its API key in .env works too. */
  model: parseModel(process.env.MODEL ?? "openai-codex/gpt-6.1-terra"),
  /** Builds the fact index and finds contradictions once per store; default the screen model. */
  backgroundModel: process.env.BACKGROUND_MODEL
    ? parseModel(process.env.BACKGROUND_MODEL)
    : undefined,
  /** Reasoning effort per job: screens must be fast, the one-off contradiction scan thorough. */
  screenThinking: thinking(process.env.SCREEN_THINKING, "low"),
  scanThinking: thinking(process.env.SCAN_THINKING, "high"),
  /** ChatGPT's fast mode for every OpenAI request: quicker, but it uses the plan's limits about twice as fast. */
  serviceTier: serviceTier(process.env.SERVICE_TIER),
  retrieval: retrieval(process.env.RETRIEVAL),
};

/** A patient's own store: no screen, fact index or note of one patient is kept with another's. */
export function storePathFor(patientId: string): string {
  return join(config.storeDir, `agent-${patientId.replace(/[^\w.-]/g, "_")}.sqlite`);
}

function retrieval(value = "index"): Retrieval {
  if (value !== "context" && value !== "tools" && value !== "hybrid" && value !== "index")
    throw new Error(`RETRIEVAL must be context, tools, hybrid or index, got "${value}".`);
  return value;
}

function serviceTier(value = "priority"): ServiceTier {
  if (value !== "priority" && value !== "default")
    throw new Error(`SERVICE_TIER must be priority or default, got "${value}".`);
  return value;
}

function thinking(value: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  if (value === undefined) return fallback;
  if (!(THINKING_LEVELS as readonly string[]).includes(value))
    throw new Error(`Thinking level must be one of ${THINKING_LEVELS.join(", ")}, got "${value}".`);
  return value as ThinkingLevel;
}
