import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai/providers/model-schema";
import {
  type ConversationId,
  configure,
  createRegistry,
  defineDoc,
  defineDocFamily,
  type Extension,
  Harness,
  type ModelRef,
  type Storage,
} from "@earendil-works/pi-durable";
import type { PatientRecord } from "@track1/patient-record";
import type { Contradiction, Need, ScreenResponse } from "@track1/shared";
import { assess } from "./assess.js";
import {
  CONTRADICTION_RULES,
  ContradictionsDoc,
  contradictionsExtension,
  recordExtension,
  SCREEN_RULES,
  ScreenDoc,
  screenExtension,
} from "./clinical.js";

const context = BACKGROUND_CONTEXT;

/** One per distinct situation text: a repeated or retried request finds the first one's conversation. */
const ScreenRequestDoc = defineDocFamily<{ conversationId: number; elapsedMs: number }, null>({
  kind: "track1.screen-request",
  version: 1,
  family: true,
  scope: "session",
  initial: () => ({ conversationId: 0, elapsedMs: 0 }),
  checkpointWhen: () => true,
});

const ScanDoc = defineDoc<{ conversationId: number; request: string }>({
  kind: "track1.scan",
  version: 1,
  scope: "session",
  initial: () => ({ conversationId: 0, request: "" }),
  checkpointWhen: () => true,
});

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RuntimeOptions {
  storage: Storage;
  models: Models;
  model: ModelRef;
  thinking?: { screen: ModelThinkingLevel; scan: ModelThinkingLevel };
  record: PatientRecord;
  /** A screen that takes longer is aborted and reported as failed. */
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** Changes with the prompt, model and thinking level, so a store never serves a result they would not give. */
function keyOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

async function within<T>(promise: Promise<T>, ms: number, onTimeout: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().catch(() => {});
      reject(new HttpError(504, `The model did not finish within ${Math.round(ms / 1000)} s.`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ClinicalRuntime {
  readonly #inflight = new Map<string, Promise<ScreenResponse>>();
  #scan: Promise<Contradiction[]> | undefined;

  private constructor(
    readonly harness: Harness,
    readonly record: PatientRecord,
    private readonly options: RuntimeOptions,
    private readonly extensions: Record<"record" | "screen" | "contradictions", Extension>,
  ) {}

  static async open(options: RuntimeOptions): Promise<ClinicalRuntime> {
    const extensions = {
      record: recordExtension(options.record),
      screen: screenExtension(options.record),
      contradictions: contradictionsExtension(options.record),
    };
    const registry = createRegistry();
    for (const extension of Object.values(extensions)) registry.install(extension);
    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        identity: { attribution: null },
        settings: { retry: { maxRetries: 2 } },
        onReport: (error, info) => options.log?.(`pi-durable reported ${info.type}`, error),
      },
      context,
    );
    // Picks up screens and scans a previous process left running.
    harness.resume();
    return new ClinicalRuntime(harness, options.record, options, extensions);
  }

  get modelName(): string {
    return `${this.options.model.provider}/${this.options.model.modelId}`;
  }

  /** Creates the conversation in the same commit that records it under `claim`, or finds the recorded one. */
  async #conversation(
    claim: (
      tx: Parameters<Parameters<Harness["commit"]>[0]>[0],
    ) => Promise<{ conversationId: number }>,
    extension: Extension,
    thinkingLevel: ModelThinkingLevel,
  ): Promise<ConversationId> {
    const id = await this.harness.commit(async (tx) => {
      const doc = await claim(tx);
      if (doc.conversationId) return doc.conversationId;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, {
        model: this.options.model,
        thinkingLevel,
        extensions: [this.extensions.record, extension],
      });
      doc.conversationId = created.id;
      return created.id;
    }, context);
    return id as ConversationId;
  }

  /** Runs one input to its end; a failed or timed-out run releases `claim` so the next request starts fresh. */
  async #run(
    conversationId: ConversationId,
    content: string,
    requestId: string,
    release: () => Promise<void>,
  ): Promise<void> {
    const conversation = await this.harness.conversation(conversationId, context);
    if (!conversation) throw new HttpError(500, "The conversation is missing from the store.");
    try {
      const submission = await conversation.submit({ type: "input", content, requestId }, context);
      const settled = await within(submission.wait(context), this.options.timeoutMs ?? 90_000, () =>
        conversation.abort(context),
      );
      if (settled.status !== "done") {
        const detail =
          "detail" in settled && typeof settled.detail === "string" ? settled.detail : "";
        throw new HttpError(502, `The model run ended without an answer. ${detail}`.trim());
      }
    } catch (error) {
      await release();
      throw error;
    }
  }

  screen(situation: string): Promise<ScreenResponse> {
    const text = situation.trim();
    if (text.length < 3) throw new HttpError(400, "Describe your role and task.");
    const { model, thinking } = this.options;
    const key = keyOf(
      SCREEN_RULES,
      `${model.provider}/${model.modelId}`,
      thinking?.screen ?? "off",
      text.toLowerCase().replace(/\s+/g, " "),
    );
    const running = this.#inflight.get(key);
    if (running) return running;
    const started = this.#screen(key, text).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, started);
    return started;
  }

  async #screen(key: string, situation: string): Promise<ScreenResponse> {
    const startedAt = Date.now();
    const conversationId = await this.#conversation(
      (tx) => tx.doc(ScreenRequestDoc, key, null),
      this.extensions.screen,
      this.options.thinking?.screen ?? "off",
    );
    let saved = await this.harness.snapshot(ScreenDoc, conversationId, context);
    const cached = Boolean(saved?.result);
    if (!cached) {
      const prompt = `Situation typed by the clinician:\n"""\n${situation}\n"""\nBuild their screen and submit it with submit_screen.`;
      await this.#run(conversationId, prompt, key, () =>
        this.harness.commit(async (tx) => {
          (await tx.doc(ScreenRequestDoc, key, null)).conversationId = 0;
        }, context),
      );
      saved = await this.harness.snapshot(ScreenDoc, conversationId, context);
      if (!saved?.result) throw new HttpError(502, "The model finished without a screen.");
      await this.harness.commit(async (tx) => {
        (await tx.doc(ScreenRequestDoc, key, null)).elapsedMs = Date.now() - startedAt;
      }, context);
    }
    const request = await this.harness.snapshot(ScreenRequestDoc, key, context);
    const result = saved?.result;
    if (!result) throw new HttpError(502, "The model finished without a screen.");
    const contradictions = await this.contradictions().catch((error: unknown) => {
      this.options.log?.("contradiction scan failed", error);
      return [];
    });
    const cited = new Set(
      result.needs.flatMap((need) => need.facts.flatMap((f) => f.sources.map((s) => s.passageId))),
    );
    const flagged = contradictions.map((c) => ({
      ...c,
      relevant: c.passages.some((p) => cited.has(p.passageId)),
    }));
    const needs = assess(
      structuredClone(result.needs) as Need[],
      contradictions,
      this.record.summary.asOf,
    );
    const summary = { green: 0, yellow: 0, red: 0 };
    for (const need of needs) summary[need.light]++;
    return {
      id: key,
      patient: this.record.summary,
      summary,
      screen: {
        situation,
        role: result.role,
        task: result.task,
        needs,
        rejected: result.rejected,
        model: this.modelName,
        elapsedMs: request?.elapsedMs || Date.now() - startedAt,
      },
      contradictions: [...flagged.filter((c) => c.relevant), ...flagged.filter((c) => !c.relevant)],
      cached,
    };
  }

  /** The record's contradictions; found once per store and kept across restarts. */
  contradictions(): Promise<Contradiction[]> {
    this.#scan ??= this.#runScan().catch((error: unknown) => {
      this.#scan = undefined;
      throw error;
    });
    return this.#scan;
  }

  async #runScan(): Promise<Contradiction[]> {
    const { model, thinking } = this.options;
    const request = `scan-${keyOf(CONTRADICTION_RULES, `${model.provider}/${model.modelId}`, thinking?.scan ?? "medium")}`;
    const conversationId = await this.#conversation(
      async (tx) => {
        const doc = await tx.doc(ScanDoc);
        if (doc.request !== request) Object.assign(doc, { conversationId: 0, request });
        return doc;
      },
      this.extensions.contradictions,
      this.options.thinking?.scan ?? "medium",
    );
    const saved = await this.harness.snapshot(ContradictionsDoc, conversationId, context);
    if (saved?.result) return structuredClone(saved.result) as Contradiction[];
    await this.#run(
      conversationId,
      "Check all documents for contradictions and report them with report_contradictions.",
      request,
      () =>
        this.harness.commit(async (tx) => {
          (await tx.doc(ScanDoc)).conversationId = 0;
        }, context),
    );
    const result = (await this.harness.snapshot(ContradictionsDoc, conversationId, context))
      ?.result;
    if (!result) throw new HttpError(502, "The contradiction scan finished without a result.");
    return structuredClone(result) as Contradiction[];
  }

  close(): Promise<void> {
    return this.harness.close(context);
  }
}
