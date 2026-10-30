import { createHash, randomUUID } from "node:crypto";
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
import type {
  Answer,
  Contradiction,
  Fact,
  Need,
  Note,
  OverviewResponse,
  ScreenResponse,
  Source,
} from "@track1/shared";
import { ANSWER_RULES, AnswerDoc, answerExtension } from "./answers.js";
import { assess } from "./assess.js";
import { basics } from "./basics.js";
import { clarifications } from "./clarify.js";
import {
  CONTRADICTION_RULES,
  ContradictionsDoc,
  contradictionsExtension,
  type Retrieval,
  recordExtension,
  SCREEN_RULES,
  ScreenDoc,
  screenExtension,
  searchExtension,
} from "./clinical.js";
import {
  FactIndexDoc,
  FactReviewDoc,
  factIndexSection,
  INDEX_RULES,
  type IndexedFact,
  indexExtension,
  REVIEW_RULES,
  reviewExtension,
} from "./factIndex.js";
import {
  bloodPressures,
  type Measurement,
  measurements,
  mergeContradictions,
  overviewTrends,
  ruleContradictions,
  trendsFor,
} from "./measurements.js";
import { safetyChecks } from "./safety.js";

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

/** One per distinct question in a distinct situation, as ScreenRequestDoc is per situation. */
const AnswerRequestDoc = defineDocFamily<{ conversationId: number; elapsedMs: number }, null>({
  kind: "track1.answer-request",
  version: 1,
  family: true,
  scope: "session",
  initial: () => ({ conversationId: 0, elapsedMs: 0 }),
  checkpointWhen: () => true,
});

/** What clinicians recorded after the documents, for every screen of the patient. */
const NotesDoc = defineDoc<{ notes: Note[] }>({
  kind: "track1.notes",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] }),
  checkpointWhen: () => true,
});

/** The patient a store belongs to: one store holds one patient's screens, fact index and notes. */
const PatientDoc = defineDoc<{ id: string }>({
  kind: "track1.patient",
  version: 1,
  scope: "session",
  initial: () => ({ id: "" }),
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
  /** How screens reach the documents; the contradiction scan always reads the whole record. */
  retrieval?: Retrieval;
  /** How many contradiction passes run, each looking for what the earlier ones missed; default 2. */
  scanPasses?: number;
  /** Builds the fact index and runs the contradiction scan, once per store; default `model`. */
  backgroundModel?: ModelRef;
  record: PatientRecord;
  /** A screen that takes longer is aborted and reported as failed. */
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** Changes with the prompt, model and thinking level, so a store never serves a result they would not give. */
function keyOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
}

const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

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
  readonly #asking = new Map<string, Promise<Answer>>();
  #scan: Promise<Contradiction[]> | undefined;
  #index: Promise<IndexedFact[]> | undefined;
  readonly #measurements: Measurement[];
  readonly #pressures: Measurement[];
  readonly #rules: Contradiction[];

  private constructor(
    readonly harness: Harness,
    readonly record: PatientRecord,
    private readonly options: RuntimeOptions,
    private readonly extensions: {
      screen: Extension[];
      answer: Extension[];
      scan: Extension[];
      index: Extension[];
      review: Extension[];
    },
  ) {
    this.#measurements = measurements(record);
    this.#pressures = bloodPressures(record);
    this.#rules = ruleContradictions(record);
  }

  static async open(options: RuntimeOptions): Promise<ClinicalRuntime> {
    const { record, retrieval = "context" } = options;
    const full = recordExtension(record);
    const screen = screenExtension(record);
    const extensions = {
      screen:
        retrieval === "context"
          ? [full, screen]
          : retrieval === "index"
            ? [full, factIndexSection, screen]
            : [recordExtension(record, retrieval), searchExtension(record), screen],
      // The whole record first, as screens and the scan have it, so the provider's cache serves it.
      answer: [full, answerExtension(record)],
      scan: [full, contradictionsExtension(record)],
      index: [full, indexExtension(record)],
      review: [reviewExtension(record)],
    };
    const registry = createRegistry();
    for (const extension of new Set(Object.values(extensions).flat())) registry.install(extension);
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
    const owner = await harness.commit(async (tx) => {
      const doc = await tx.doc(PatientDoc);
      doc.id ||= record.summary.id;
      return doc.id;
    }, context);
    if (owner !== record.summary.id) {
      await harness.close(context);
      throw new Error(`The store belongs to patient ${owner}, not to ${record.summary.id}.`);
    }
    // Picks up screens and scans a previous process left running.
    harness.resume();
    return new ClinicalRuntime(harness, options.record, options, extensions);
  }

  get modelName(): string {
    return `${this.options.model.provider}/${this.options.model.modelId}`;
  }

  get #background(): ModelRef {
    return this.options.backgroundModel ?? this.options.model;
  }

  /** What the background work depends on besides its prompt: its model and thinking level. */
  get #backgroundKey(): string {
    const { provider, modelId } = this.#background;
    return `${provider}/${modelId}\n${this.options.thinking?.scan ?? "medium"}`;
  }

  /** Creates the conversation in the same commit that records it under `claim`, or finds the recorded one. */
  async #conversation(
    claim: (
      tx: Parameters<Parameters<Harness["commit"]>[0]>[0],
    ) => Promise<{ conversationId: number }>,
    extensions: Extension[],
    thinkingLevel: ModelThinkingLevel,
    model: ModelRef = this.options.model,
  ): Promise<ConversationId> {
    const id = await this.harness.commit(async (tx) => {
      const doc = await claim(tx);
      if (doc.conversationId) return doc.conversationId;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, {
        model,
        thinkingLevel,
        extensions,
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
    const { model, thinking, retrieval = "context" } = this.options;
    const key = keyOf(
      SCREEN_RULES,
      `${model.provider}/${model.modelId}`,
      thinking?.screen ?? "off",
      retrieval,
      retrieval === "index" ? `${INDEX_RULES}\n${REVIEW_RULES}\n${this.#backgroundKey}` : "",
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
    if (this.options.retrieval === "index") await this.factIndex();
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
    const found = await this.#modelContradictions().catch((error: unknown) => {
      this.options.log?.("contradiction scan failed", error);
      return [];
    });
    const contradictions = mergeContradictions(this.#rules, found);
    const facts = result.needs.flatMap((need) => need.facts);
    const cited = new Set(facts.flatMap((f) => f.sources.map((s) => s.passageId)));
    const trends = trendsFor(this.#measurements, facts);
    const index = this.options.retrieval === "index" ? await this.factIndex().catch(() => []) : [];
    const checks = safetyChecks(
      this.record,
      [situation, result.role, result.task].join("\n"),
      [...facts, ...index],
      contradictions,
    );
    const leftOut = result.leftOut ?? [];
    const flagged = contradictions.map((c) => ({
      ...c,
      relevant: c.passages.some((p) => cited.has(p.passageId)),
    }));
    const needs = assess(
      structuredClone(result.needs) as Need[],
      contradictions,
      this.record.summary.asOf,
    );
    const basicFacts = basics(this.record, this.#measurements, index, contradictions);
    const clarify = clarifications({
      needs,
      checks,
      contradictions: flagged,
      measurements: this.#measurements,
      asOf: this.record.summary.asOf,
    });
    const passages = this.#passages([
      ...facts.flatMap((f) => f.sources),
      ...checks.flatMap((c) => c.items.flatMap((i) => i.sources)),
      ...leftOut.flatMap((l) => l.sources),
      ...contradictions.flatMap((c) => c.passages),
      ...trends.flatMap((t) => t.points.flatMap((p) => p.sources)),
      ...Object.values(basicFacts).flatMap((list) => list.flatMap((f) => f.sources)),
      ...clarify.flatMap((c) => c.sources),
    ]);
    const summary = { green: 0, yellow: 0, red: 0 };
    for (const need of needs) summary[need.light]++;
    return {
      // The key is per store, so the same situation would give two patients the same key.
      id: keyOf(this.record.summary.id, key),
      patient: this.record.summary,
      summary,
      screen: {
        situation,
        role: result.role,
        task: result.task,
        ...(result.occasion ? { occasion: result.occasion } : {}),
        needs,
        leftOut,
        rejected: result.rejected,
        model: this.modelName,
        elapsedMs: request?.elapsedMs || Date.now() - startedAt,
      },
      contradictions: [...flagged.filter((c) => c.relevant), ...flagged.filter((c) => !c.relevant)],
      trends,
      checks,
      basics: basicFacts,
      clarify,
      passages,
      cached,
    };
  }

  /** Full text and section of each cited passage, for previews. */
  #passages(sources: readonly Source[]): ScreenResponse["passages"] {
    const passages: ScreenResponse["passages"] = {};
    for (const source of sources) {
      const passage = this.record.passage(source.passageId);
      if (passage) passages[passage.id] = { text: passage.text, section: passage.section };
    }
    return passages;
  }

  /** Answers a follow-up question in the situation of a screen, from the documents only. */
  ask(situation: string, question: string): Promise<Answer> {
    const text = question.trim();
    if (text.length < 3) throw new HttpError(400, "Ask a question about the patient's documents.");
    const { model, thinking } = this.options;
    const key = keyOf(
      ANSWER_RULES,
      `${model.provider}/${model.modelId}`,
      thinking?.screen ?? "off",
      normalized(situation),
      normalized(text),
    );
    const running = this.#asking.get(key);
    if (running) return running;
    const started = this.#answer(key, situation.trim(), text).finally(() =>
      this.#asking.delete(key),
    );
    this.#asking.set(key, started);
    return started;
  }

  async #answer(key: string, situation: string, question: string): Promise<Answer> {
    const startedAt = Date.now();
    const conversationId = await this.#conversation(
      (tx) => tx.doc(AnswerRequestDoc, key, null),
      this.extensions.answer,
      this.options.thinking?.screen ?? "off",
    );
    let saved = await this.harness.snapshot(AnswerDoc, conversationId, context);
    const cached = Boolean(saved?.result);
    if (!cached) {
      const prompt = `Situation typed by the clinician:\n"""\n${situation}\n"""\nTheir question about the record:\n"""\n${question}\n"""\nAnswer it and submit the answer with submit_answer.`;
      await this.#run(conversationId, prompt, key, () =>
        this.harness.commit(async (tx) => {
          (await tx.doc(AnswerRequestDoc, key, null)).conversationId = 0;
        }, context),
      );
      saved = await this.harness.snapshot(AnswerDoc, conversationId, context);
      if (!saved?.result) throw new HttpError(502, "The model finished without an answer.");
      await this.harness.commit(async (tx) => {
        (await tx.doc(AnswerRequestDoc, key, null)).elapsedMs = Date.now() - startedAt;
      }, context);
    }
    const result = saved?.result;
    if (!result) throw new HttpError(502, "The model finished without an answer.");
    const request = await this.harness.snapshot(AnswerRequestDoc, key, context);
    const found = await this.#modelContradictions().catch((error: unknown) => {
      this.options.log?.("contradiction scan failed", error);
      return [];
    });
    const [assessed] = assess(
      [
        {
          title: result.topic,
          status: "documented",
          facts: structuredClone(result.facts) as Fact[],
        },
      ],
      mergeContradictions(this.#rules, found),
      this.record.summary.asOf,
    );
    const facts = assessed?.facts ?? [];
    return {
      id: key,
      question,
      topic: result.topic,
      facts,
      ...(result.missing ? { missing: structuredClone(result.missing) } : {}),
      rejected: result.rejected,
      passages: this.#passages(facts.flatMap((f) => f.sources)),
      model: this.modelName,
      elapsedMs: request?.elapsedMs || Date.now() - startedAt,
      cached,
    };
  }

  /**
   * The start page's overview: the measurements, the basics every screen shows and the
   * contradictions. It builds no screen; it waits only for the once-per-store index and scan.
   */
  async overview(): Promise<OverviewResponse> {
    const index = this.options.retrieval === "index" ? await this.factIndex().catch(() => []) : [];
    const contradictions = await this.contradictions().catch((error: unknown) => {
      this.options.log?.("contradiction scan failed", error);
      return this.#rules;
    });
    return {
      vitals: overviewTrends(this.#measurements, this.#pressures),
      basics: basics(this.record, this.#measurements, index, contradictions),
      contradictions,
    };
  }

  /** What clinicians recorded after the documents, oldest first. */
  async notes(): Promise<Note[]> {
    return structuredClone((await this.harness.snapshot(NotesDoc, context))?.notes ?? []) as Note[];
  }

  async addNote(input: {
    topic: string;
    text: string;
    source: Note["source"];
    clarifies?: string;
    author?: string;
  }): Promise<Note> {
    const topic = input.topic.trim();
    const text = input.text.trim();
    if (!topic || !text) throw new HttpError(400, "A note needs a topic and a text.");
    const note: Note = {
      id: randomUUID(),
      topic,
      text,
      source: input.source,
      ...(input.clarifies?.trim() ? { clarifies: input.clarifies.trim() } : {}),
      ...(input.author ? { author: input.author } : {}),
      recordedAt: new Date().toISOString(),
    };
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(NotesDoc);
      doc.notes = [...doc.notes, note];
    }, context);
    return note;
  }

  async removeNote(id: string): Promise<void> {
    const removed = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(NotesDoc);
      const kept = doc.notes.filter((note) => note.id !== id);
      if (kept.length === doc.notes.length) return false;
      doc.notes = kept;
      return true;
    }, context);
    if (!removed) throw new HttpError(404, `No note ${id}.`);
  }

  /** The rule checks' contradictions, then the model scan's that do not restate one of them. */
  async contradictions(): Promise<Contradiction[]> {
    return mergeContradictions(this.#rules, await this.#modelContradictions());
  }

  /** The model scan's contradictions; found once per store and kept across restarts. */
  #modelContradictions(): Promise<Contradiction[]> {
    this.#scan ??= this.#runScan().catch((error: unknown) => {
      this.#scan = undefined;
      throw error;
    });
    return this.#scan;
  }

  async #runScan(): Promise<Contradiction[]> {
    const passes = this.options.scanPasses ?? 2;
    const request = `scan-${keyOf(CONTRADICTION_RULES, this.#backgroundKey, `passes ${passes}`)}`;
    const conversationId = await this.#conversation(
      async (tx) => {
        const doc = await tx.doc(ScanDoc);
        if (doc.request !== request) Object.assign(doc, { conversationId: 0, request });
        return doc;
      },
      this.extensions.scan,
      this.options.thinking?.scan ?? "medium",
      this.#background,
    );
    // Each pass sees what the earlier ones saved, in its own transcript, and adds only what they missed.
    for (let pass = 1; pass <= passes; pass++) {
      const saved = await this.harness.snapshot(ContradictionsDoc, conversationId, context);
      if ((saved?.passes ?? 0) >= pass) continue;
      await this.harness.commit(async (tx) => {
        Object.assign(await tx.doc(ContradictionsDoc, conversationId), {
          wanted: pass,
          attempts: 0,
        });
      }, context);
      await this.#run(
        conversationId,
        pass === 1
          ? "Check all documents for contradictions and report them with report_contradictions."
          : "Read every document again, passage by passage, for contradictions that are not in what you already saved, including findings described differently in two documents. Report only new ones with report_contradictions, or an empty list if there are none.",
        pass === 1 ? request : `${request}-pass-${pass}`,
        () =>
          this.harness.commit(async (tx) => {
            (await tx.doc(ScanDoc)).conversationId = 0;
          }, context),
      );
    }
    const result = (await this.harness.snapshot(ContradictionsDoc, conversationId, context))
      ?.result;
    if (!result) throw new HttpError(502, "The contradiction scan finished without a result.");
    return structuredClone(result) as Contradiction[];
  }

  /** Starts the once-per-store work in the background, so the first screen rarely waits for it. */
  prepare(log: (message: string, error?: unknown) => void): void {
    void this.#modelContradictions().catch((error) => log("contradiction scan failed", error));
    if (this.options.retrieval === "index")
      void this.factIndex().catch((error) => log("fact index failed", error));
  }

  /** Every fact of the record, extracted and reviewed once per store and kept across restarts. */
  factIndex(): Promise<IndexedFact[]> {
    this.#index ??= this.#buildIndex()
      .then((request) => this.#reviewIndex(request))
      .catch((error: unknown) => {
        this.#index = undefined;
        throw error;
      });
    return this.#index;
  }

  /** Builds the index unless the store has it; resolves with the request that identifies it. */
  async #buildIndex(): Promise<string> {
    const request = `index-${keyOf(INDEX_RULES, this.#backgroundKey)}`;
    const conversationId = await this.#conversation(
      async (tx) => {
        const doc = await tx.doc(FactIndexDoc);
        if (doc.request !== request)
          Object.assign(doc, { conversationId: 0, request, attempts: 0, facts: null });
        return doc;
      },
      this.extensions.index,
      this.options.thinking?.scan ?? "medium",
      this.#background,
    );
    if ((await this.harness.snapshot(FactIndexDoc, context))?.facts) return request;
    await this.#run(
      conversationId,
      "Index every clinically relevant fact of all documents and save it with submit_index.",
      request,
      () =>
        this.harness.commit(async (tx) => {
          (await tx.doc(FactIndexDoc)).conversationId = 0;
        }, context),
    );
    if (!(await this.harness.snapshot(FactIndexDoc, context))?.facts)
      throw new HttpError(502, "The fact index finished without a result.");
    return request;
  }

  /** Checks each indexed value against its passages; corrections and removals land in the index. */
  async #reviewIndex(indexRequest: string): Promise<IndexedFact[]> {
    const request = `review-${keyOf(REVIEW_RULES, this.#backgroundKey, indexRequest)}`;
    const conversationId = await this.#conversation(
      async (tx) => {
        const doc = await tx.doc(FactReviewDoc);
        if (doc.request !== request)
          Object.assign(doc, { conversationId: 0, request, attempts: 0, done: false });
        return doc;
      },
      this.extensions.review,
      this.options.thinking?.scan ?? "medium",
      this.#background,
    );
    if (!(await this.harness.snapshot(FactReviewDoc, context))?.done)
      await this.#run(
        conversationId,
        "Review every fact of the index against its passages and save your verdicts with submit_review.",
        request,
        () =>
          this.harness.commit(async (tx) => {
            (await tx.doc(FactReviewDoc)).conversationId = 0;
          }, context),
      );
    const facts = (await this.harness.snapshot(FactIndexDoc, context))?.facts;
    if (!facts) throw new HttpError(502, "The fact index is missing after its review.");
    return structuredClone(facts) as IndexedFact[];
  }

  /** How the review changed the index, for the eval. */
  async indexReview(): Promise<{ corrected: number; dropped: number } | undefined> {
    const review = await this.harness.snapshot(FactReviewDoc, context);
    return review?.done ? { corrected: review.corrected, dropped: review.dropped } : undefined;
  }

  close(): Promise<void> {
    return this.harness.close(context);
  }
}
