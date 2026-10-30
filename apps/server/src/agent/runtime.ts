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
import { ANSWER_RULES, AnswerDoc, answerExtension, unreadable } from "./answers.js";
import { assess } from "./assess.js";
import { basics } from "./basics.js";
import { clarifications } from "./clarify.js";
import {
  CONTRADICTION_RULES,
  ContradictionsDoc,
  contradictionsExtension,
  documentText,
  type Retrieval,
  recordExtension,
  SCREEN_RULES,
  ScreenDoc,
  screenExtension,
  searchExtension,
} from "./clinical.js";
import {
  FactIndexDoc,
  factIndexSection,
  INDEX_RULES,
  type IndexedFact,
  type IndexPart,
  IndexPartDoc,
  indexExtension,
  indexParts,
  REVIEW_RULES,
  ReviewPartDoc,
  reviewExtension,
  withCategories,
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
import { inBackground, Slots } from "./slots.js";

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
  /** `index` is for the fact index and its review; default `scan`. */
  thinking?: { screen: ModelThinkingLevel; scan: ModelThinkingLevel; index?: ModelThinkingLevel };
  /** How screens reach the documents; the contradiction scan always reads the whole record. */
  retrieval?: Retrieval;
  /** How many contradiction passes run, each looking for what the earlier ones missed; default 2. */
  scanPasses?: number;
  /** Builds the fact index and runs the contradiction scan, once per store; default `model`. */
  backgroundModel?: ModelRef;
  record: PatientRecord;
  /** Background runs of every runtime that shares it; default 16 for this runtime alone. */
  backgroundSlots?: Slots;
  /** Pauses before a failed background run is tried again; default 3 s, then 10 s. */
  retryPausesMs?: readonly number[];
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
  /** The scan's contradictions once it has finished; screens and answers never wait for it. */
  #scanned: Contradiction[] | undefined;
  #index: Promise<IndexedFact[]> | undefined;
  readonly #slots: Slots;
  readonly #measurements: Measurement[];
  readonly #pressures: Measurement[];
  readonly #rules: Contradiction[];

  private constructor(
    readonly harness: Harness,
    readonly record: PatientRecord,
    private readonly options: RuntimeOptions,
    private readonly extensions: {
      screen: Extension[];
      /** For a screen asked before the fact index is ready: the whole record, as `context` has it. */
      screenWithoutIndex: Extension[];
      answer: Extension[];
      scan: Extension[];
      index: Extension[];
      review: Extension[];
    },
  ) {
    this.#slots = options.backgroundSlots ?? new Slots(16);
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
      screenWithoutIndex: [full, screen],
      // The whole record first, as screens and the scan have it, so the provider's cache serves it.
      answer: [full, answerExtension(record)],
      scan: [full, contradictionsExtension(record)],
      // Only the part's own document: a short prompt starts answering sooner.
      index: [indexExtension(record, (documentId) => documentText(record, documentId))],
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

  /**
   * Never waits for the once-per-store work: before the fact index is ready a screen reads the
   * whole record instead, and its contradictions are the rule checks' plus whatever the scan has.
   */
  async screen(situation: string): Promise<ScreenResponse> {
    const text = situation.trim();
    if (text.length < 3) throw new HttpError(400, "Describe your role and task.");
    const { model, thinking, retrieval = "context" } = this.options;
    const keyFor = (used: Retrieval) =>
      keyOf(
        SCREEN_RULES,
        `${model.provider}/${model.modelId}`,
        thinking?.screen ?? "off",
        used,
        used === "index" ? this.#indexRequest : "",
        normalized(text),
      );
    const index = retrieval === "index" ? await this.#readyIndex() : undefined;
    let withoutIndex = retrieval === "index" && !index;
    let key = keyFor(withoutIndex ? "context" : retrieval);
    // A situation first asked before the index was ready keeps the screen it got then.
    if (index && !(await this.#hasScreen(key)) && (await this.#hasScreen(keyFor("context")))) {
      withoutIndex = true;
      key = keyFor("context");
    }
    const running = this.#inflight.get(key);
    if (running) return running;
    const extensions = withoutIndex ? this.extensions.screenWithoutIndex : this.extensions.screen;
    const started = this.#screen(key, text, extensions, index ?? []).finally(() =>
      this.#inflight.delete(key),
    );
    this.#inflight.set(key, started);
    return started;
  }

  async #hasScreen(key: string): Promise<boolean> {
    const request = await this.harness.snapshot(ScreenRequestDoc, key, context);
    if (!request?.conversationId) return false;
    const conversationId = request.conversationId as ConversationId;
    return Boolean((await this.harness.snapshot(ScreenDoc, conversationId, context))?.result);
  }

  async #screen(
    key: string,
    situation: string,
    extensions: Extension[],
    index: IndexedFact[],
  ): Promise<ScreenResponse> {
    const startedAt = Date.now();
    const conversationId = await this.#conversation(
      (tx) => tx.doc(ScreenRequestDoc, key, null),
      extensions,
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
    const contradictions = mergeContradictions(this.#rules, this.#scannedSoFar());
    const facts = result.needs.flatMap((need) => need.facts);
    const cited = new Set(facts.flatMap((f) => f.sources.map((s) => s.passageId)));
    const trends = trendsFor(this.#measurements, facts);
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
      withCategories(structuredClone(result.needs) as Need[], index),
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
    // Keyboard mash gets no model run: the model would otherwise make an answer out of it.
    if (unreadable(text))
      throw new HttpError(400, "That does not read as a question. Ask about the documents.");
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
    const found = this.#scannedSoFar();
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
    this.#scan ??= this.#inBackground(() => this.#runScan()).then(
      (found) => {
        this.#scanned = found;
        return found;
      },
      (error: unknown) => {
        this.#scan = undefined;
        throw error;
      },
    );
    return this.#scan;
  }

  /** The scan's contradictions if it has finished; otherwise none yet, and the scan is started. */
  #scannedSoFar(): Contradiction[] {
    if (!this.#scanned)
      void this.#modelContradictions().catch((error) =>
        this.options.log?.("contradiction scan failed", error),
      );
    return this.#scanned ?? [];
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

  #inBackground<T>(run: () => Promise<T>): Promise<T> {
    return inBackground(this.#slots, run, this.options.retryPausesMs, this.options.log);
  }

  /** Starts the once-per-store work in the background; no screen or answer waits for it. */
  prepare(log: (message: string, error?: unknown) => void): void {
    void this.#modelContradictions().catch((error) => log("contradiction scan failed", error));
    if (this.options.retrieval === "index")
      void this.factIndex().catch((error) => log("fact index failed", error));
  }

  /**
   * The reviewed index if the store has it, without waiting for one to be built; a missing index
   * is started in the background.
   */
  async #readyIndex(): Promise<IndexedFact[] | undefined> {
    const stored = await this.harness.snapshot(FactIndexDoc, context);
    if (stored?.facts && stored.request === this.#indexRequest)
      return structuredClone(stored.facts) as IndexedFact[];
    void this.factIndex().catch((error) => this.options.log?.("fact index failed", error));
    return undefined;
  }

  get #indexRequest(): string {
    const { thinking } = this.options;
    return `index-${keyOf(INDEX_RULES, REVIEW_RULES, this.#backgroundKey, thinking?.index ?? "", "parts")}`;
  }

  /** Every fact of the record, extracted and reviewed once per store and kept across restarts. */
  factIndex(): Promise<IndexedFact[]> {
    this.#index ??= this.#buildIndex().catch((error: unknown) => {
      this.#index = undefined;
      throw error;
    });
    return this.#index;
  }

  /**
   * Indexes and reviews every part of the record at once, then merges the parts in record order.
   * IDs count the facts as indexed, f1, f2 and so on, so one the review removed leaves a gap. A part
   * already done in the store is not run again.
   */
  async #buildIndex(): Promise<IndexedFact[]> {
    const request = this.#indexRequest;
    const stored = await this.harness.snapshot(FactIndexDoc, context);
    if (stored?.facts && stored.request === request)
      return structuredClone(stored.facts) as IndexedFact[];
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(FactIndexDoc);
      if (doc.request !== request)
        Object.assign(doc, { request, runs: {}, facts: null, corrected: 0, dropped: 0 });
    }, context);
    const parts = await Promise.all(
      indexParts(this.record).map((part) =>
        this.#inBackground(() => this.#indexPart(request, part)),
      ),
    );
    let offset = 0;
    const facts = parts.flatMap((part) => {
      const ids = part.facts.map((f) => ({ ...f, id: `f${offset + Number(f.id.slice(1))}` }));
      offset += part.indexed;
      return ids;
    });
    await this.harness.commit(async (tx) => {
      Object.assign(await tx.doc(FactIndexDoc), {
        facts,
        corrected: parts.reduce((sum, part) => sum + part.corrected, 0),
        dropped: parts.reduce((sum, part) => sum + part.dropped, 0),
      });
    }, context);
    return facts;
  }

  /** One part: its index run, then a review of that run's facts against their passages. */
  async #indexPart(
    request: string,
    part: IndexPart,
  ): Promise<{ facts: IndexedFact[]; indexed: number; corrected: number; dropped: number }> {
    const indexId = await this.#partConversation(`${part.key} index`, this.extensions.index);
    await this.harness.commit(async (tx) => {
      (await tx.doc(IndexPartDoc, indexId)).part ||= part.key;
    }, context);
    if (!(await this.harness.snapshot(IndexPartDoc, indexId, context))?.facts)
      await this.#run(
        indexId,
        "Index every clinically relevant fact of your part and save it with submit_index.",
        `${request}-${part.key}-index`,
        () => this.#releasePart(`${part.key} index`),
      );
    const indexed = (await this.harness.snapshot(IndexPartDoc, indexId, context))?.facts;
    if (!indexed) throw new HttpError(502, `The fact index of ${part.key} has no result.`);
    if (indexed.length === 0) return { facts: [], indexed: 0, corrected: 0, dropped: 0 };

    const reviewId = await this.#partConversation(`${part.key} review`, this.extensions.review);
    await this.harness.commit(async (tx) => {
      (await tx.doc(ReviewPartDoc, reviewId)).index ||= indexId;
    }, context);
    if (!(await this.harness.snapshot(ReviewPartDoc, reviewId, context))?.done)
      await this.#run(
        reviewId,
        "Review every fact of the index against its passages and save your verdicts with submit_review.",
        `${request}-${part.key}-review`,
        () => this.#releasePart(`${part.key} review`),
      );
    const review = await this.harness.snapshot(ReviewPartDoc, reviewId, context);
    const facts = (await this.harness.snapshot(IndexPartDoc, indexId, context))?.facts;
    if (!review?.done || !facts)
      throw new HttpError(502, `The review of ${part.key} finished without a result.`);
    return {
      facts: structuredClone(facts) as IndexedFact[],
      indexed: indexed.length,
      corrected: review.corrected,
      dropped: review.dropped,
    };
  }

  #partConversation(run: string, extensions: Extension[]): Promise<ConversationId> {
    return this.#conversation(
      async (tx) => {
        const doc = await tx.doc(FactIndexDoc);
        doc.runs[run] ??= { conversationId: 0 };
        return doc.runs[run];
      },
      extensions,
      this.options.thinking?.index ?? this.options.thinking?.scan ?? "medium",
      this.#background,
    );
  }

  /** A failed run starts in a fresh conversation next time. */
  #releasePart(run: string): Promise<void> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(FactIndexDoc);
      if (doc.runs[run]) doc.runs[run].conversationId = 0;
    }, context);
  }

  /** How the review changed the index, for the eval. */
  async indexReview(): Promise<{ corrected: number; dropped: number } | undefined> {
    const doc = await this.harness.snapshot(FactIndexDoc, context);
    return doc?.facts ? { corrected: doc.corrected, dropped: doc.dropped } : undefined;
  }

  close(): Promise<void> {
    return this.harness.close(context);
  }
}
