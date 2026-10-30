import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FileCredentialStore } from "../src/auth/credentials.js";
import { withServiceTier } from "../src/service-tier.js";

/** A ChatGPT access token as far as the Codex provider reads it: only the account ID claim. */
const token = [
  "e30",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
  ).toString("base64url"),
  "sig",
].join(".");

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "track1-tier-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** The JSON body each request would have sent; the network answers 500, so the stream just ends in an error. */
async function sentBodies(tier: "priority" | "default", provider: string, modelId: string) {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    // Codex compresses its request bodies, as the backend expects.
    const body = init?.body as string | Uint8Array;
    const zstd = new Headers(init?.headers).get("content-encoding") === "zstd";
    bodies.push(JSON.parse(zstd ? zstdDecompressSync(body).toString() : String(body)));
    return new Response("{}", { status: 500 });
  };
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  // What a finished ChatGPT sign-in stores.
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: token,
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
  }));
  const models = withServiceTier(builtinModels({ credentials }), tier);
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`No model ${provider}/${modelId}`);
  const events = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
    { apiKey: token, transport: "sse", fetch, maxRetries: 0 },
  );
  for await (const _ of events);
  return bodies;
}

it("sends ChatGPT requests in fast mode unless the tier is default", async () => {
  const fast = await sentBodies("priority", "openai-codex", "gpt-6.1-terra");
  expect(fast.length).toBeGreaterThan(0);
  for (const body of fast) expect(body.service_tier).toBe("priority");

  const normal = await sentBodies("default", "openai-codex", "gpt-6.1-terra");
  expect(normal.length).toBeGreaterThan(0);
  for (const body of normal) expect(body).not.toHaveProperty("service_tier");
});

it("leaves the tier off providers that do not know it", async () => {
  const bodies = await sentBodies("priority", "openrouter", "anthropic/claude-haiku-4.5");
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toHaveProperty("service_tier");
});
