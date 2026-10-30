import { type Static, Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";
import type { PatientRecord } from "@track1/patient-record";
import type { Contradiction, LeftOut, Need } from "@track1/shared";
import { Cited, MAX_ATTEMPTS, parseArrays, retryText, verify } from "./citations.js";
import { DrugParts, FactIndexDoc, factParts, type IndexedFact } from "./factIndex.js";

export const ScreenDoc = defineDoc<{
  attempts: number;
  result: {
    role: string;
    task: string;
    occasion?: string;
    needs: Need[];
    leftOut?: LeftOut[];
    rejected: number;
  } | null;
}>({
  kind: "track1.screen",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: 0, result: null }),
  checkpointWhen: () => true,
});

export const ContradictionsDoc = defineDoc<{
  attempts: number;
  result: Contradiction[] | null;
  /** Passes saved, and the pass the scan is on: a later pass reports only what earlier ones missed. */
  passes: number;
  wanted: number;
}>({
  kind: "track1.contradictions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: 0, result: null, passes: 0, wanted: 1 }),
  checkpointWhen: () => true,
});

/** How the model reaches the documents: all in its context, through search tools, or both. */
export type Retrieval = "context" | "tools" | "hybrid" | "index";

function recordHeader(record: PatientRecord): string[] {
  const { summary } = record;
  return [
    `Patient: ${summary.name}, ${summary.sex}, born ${summary.dateOfBirth}.`,
    `The documents are German clinical letters that call her "Beispielpatientin" or "NN_${summary.id}". The latest document is from ${summary.asOf}; she was ${summary.ageAsOf} then. Present tense means as of that date.`,
  ];
}

function documentLine(doc: PatientRecord["documents"][number]): string {
  return `=== Document ${doc.id} | ${doc.date} | ${doc.title} | ${doc.type} | ${doc.department}`;
}

function recordText(record: PatientRecord, retrieval: Retrieval): string {
  if (retrieval === "tools")
    return [
      ...recordHeader(record),
      "Find passages with search_documents and read_document, and cite them by their passage ID. Search every document for every need; search with German terms.",
      "",
      ...record.documents.map((doc) => `${documentLine(doc)} | ${doc.passages.length} passages`),
    ].join("\n");
  return [
    ...recordHeader(record),
    "Every line below is one passage: [passage ID] text. Cite passages by their ID.",
    "",
    ...record.documents.map((doc) =>
      [documentLine(doc), ...doc.passages.map((p) => `[${p.id}] ${p.text}`)].join("\n"),
    ),
  ].join("\n");
}

/** The record as the first prompt section: identical for every conversation, so providers cache it. */
export function recordExtension(record: PatientRecord, retrieval: Retrieval = "context") {
  const text = recordText(record, retrieval);
  return defineExtension({
    name: retrieval === "tools" ? "patient-index" : "patient-record",
    sections: [section("patient_record", () => text)],
  });
}

const SEARCH_LIMIT = 40;

/** Passages matching any of the words, or the pattern when `query` is a regular expression. */
function search(record: PatientRecord, query: string, documentId?: string) {
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, "i");
  } catch {
    pattern = new RegExp(
      query
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "i",
    );
  }
  return record.documents
    .filter((doc) => !documentId || doc.id === documentId)
    .flatMap((doc) => doc.passages.filter((p) => pattern.test(p.text)).map((p) => ({ doc, p })));
}

/** Search tools over the passages, as ripgrep would over the files. */
export function searchExtension(record: PatientRecord) {
  const searchDocuments = defineTool({
    name: "search_documents",
    description:
      "Search the passages of all documents, case-insensitive, like ripgrep. `query` is a regular expression such as `Allergie|KM-` or plain words, any of which may match. Returns passage IDs with their text.",
    parameters: Type.Object({
      query: Type.String({ description: "Regular expression or words, usually German." }),
      document: Type.Optional(Type.String({ description: "Only this document ID." })),
    }),
    replay: "safe",
    execute: async (args) => {
      const hits = search(record, args.query, args.document);
      const lines = hits
        .slice(0, SEARCH_LIMIT)
        .map(({ doc, p }) => `[${p.id}] (${doc.title}, ${doc.date}) ${p.text}`);
      const more =
        hits.length > SEARCH_LIMIT ? `\n${hits.length - SEARCH_LIMIT} more; narrow the query.` : "";
      return {
        output: [
          { type: "text", text: lines.length ? lines.join("\n") + more : "No passage matches." },
        ],
      };
    },
  });
  const readDocument = defineTool({
    name: "read_document",
    description: "Read one whole document as its passages, each with its passage ID.",
    parameters: Type.Object({ id: Type.String({ description: "Document ID, such as 12340012." }) }),
    replay: "safe",
    execute: async (args) => {
      const doc = record.document(args.id.trim());
      const text = doc
        ? [documentLine(doc), ...doc.passages.map((p) => `[${p.id}] ${p.text}`)].join("\n")
        : `No document ${args.id}.`;
      return { output: [{ type: "text", text }] };
    },
  });
  return defineExtension({ name: "search", tools: [searchDocuments, readDocument] });
}

export const SCREEN_RULES = `You prepare one screen for a clinician: only the facts from this patient's documents that their role and task need. The user message is the situation the clinician typed, usually their role and task in English. When it starts with "Role: X.", X is the clinician's role and replaces any role named after it; keep the occasion and work out the task X has in it.

1. Work out what this clinician needs for this task, usually 5 to 8 needs. Go through these kinds of facts and keep those that matter for the task:
   - the presenting problem: earlier episodes, what was found, what it was put down to, and the side and severity of the findings;
   - medication with dose and schedule, above all drugs that matter for the planned intervention, such as blood thinners before surgery or drugs to stop or check before contrast media or anaesthesia;
   - allergies and earlier reactions;
   - the function of the organs the intervention depends on, such as heart, kidneys, liver, lungs and airway, with the latest values;
   - the latest relevant measurements and how they changed, such as weight, blood pressure and laboratory values;
   - diagnoses with histology, stage and markers when the task is about that disease;
   - plans and recommendations with their dates, follow-ups and whether they took place.
   Leave out what does not matter for this task, such as tumour receptor status for an anaesthetist.
2. Search all documents for every need. Where values changed over time, give the latest with its date, and earlier ones when the change matters.
3. Keep it to one screen: up to 4 facts per need. Write like a clinician's chart, with the standard abbreviations such as HbA1c, LVEF, BP, HR, BMI, eGFR, ECG, TTE, HTN, T2DM, OSA, GERD and SLE instead of their full terms. Each need has a title of at most 2 words, such as "Cardio", "Airway", "Kidneys" or "Diabetes". Every fact has a label of at most 2 words, a value, a detail and the date it refers to. The value answers the label in at most 4 words, such as "60 %", "Grade II", "Left" or "Aspirin 100 mg"; the detail says what qualifies it in at most 6 words, such as "TTE, normal systolic" or "1-0-0, since 06/2019". When the answer is a number, the value is the number with what it measures, such as "LVEF 60 %" or "HbA1c 7.2 %", never a description that hides it in the detail. For an allergy, the value is the agent, such as "Contrast media", and the detail is the reaction. A drug also has its parts in drug: generic name, brand, dose of one intake, schedule and route. Translate German terms; you may add generic names to brand names and compute values such as a weight change, citing the inputs. Write medication schedules as morning-midday-evening, so the table row "1 0 1 0" is 1-0-1. Give the occasion as well: what the task is for in at most 8 words, such as "Hip replacement, 12 March 2021".
4. Each source is a passage ID and a short verbatim quote of that passage. Every claim in a value, detail or drug part needs a quote that says it; when a fact combines several passages, cite each of them.
5. When the documents do not contain something the task needs, make it its own need with status "not_documented", no facts, a note of at most 6 words naming what is missing, such as "Creatinine, eGFR, K+", and an action: one step of at most 5 words that would close the gap, such as "Ask about earlier anaesthesia" or "Order before surgery". Check in particular the organ function and laboratory values that the planned intervention or the listed drugs depend on. A fact never says that something is missing. Never fill a gap from general knowledge.
6. State only what the documents say. No advice and no recommendations of your own, except the action of a not_documented need.
7. In leftOut, name up to 6 topics the documents contain that you left out because this task does not need them, such as "Tumour receptor status" for an anaesthetist. Each is a topic of at most 4 words without its value, with one source passage that documents it.
8. Call submit_screen once with the complete screen. Do not answer in text.`;

/** A fact that only says something is missing belongs in a not_documented need. */
export const SAYS_MISSING =
  /\b(not (documented|reported|recorded|available|found|mentioned)|no (record|documentation|data)|undocumented)\b/i;

export const FactArgs = Type.Object({
  label: Type.String({ description: "Short English label, such as 'Antiplatelet'." }),
  value: Type.String({
    description: "The answer in at most 6 words, such as '60 %' or 'Aspirin 100 mg'.",
  }),
  detail: Type.Optional(
    Type.String({ description: "What qualifies the value, at most 15 words, such as '1-0-0'." }),
  ),
  date: Type.Optional(Type.String({ description: "YYYY-MM-DD the fact refers to." })),
  drug: Type.Optional(DrugParts),
  sources: Type.Array(Cited, { minItems: 1 }),
  calculation: Type.Optional(
    Type.Boolean({ description: "True for a value computed from the cited inputs." }),
  ),
});

const ScreenArgs = Type.Object({
  role: Type.String({ description: "The clinician's role in English, at most 4 words." }),
  task: Type.String({ description: "The task in English, at most 8 words." }),
  occasion: Type.Optional(
    Type.String({
      description: "What the task is for, at most 8 words, such as 'Hip replacement, 12 March 2021'.",
    }),
  ),
  needs: Type.Array(
    Type.Object({
      title: Type.String({ description: "What the task needs, such as 'Blood thinners'." }),
      status: Type.Union([Type.Literal("documented"), Type.Literal("not_documented")]),
      factIds: Type.Optional(
        Type.Array(Type.String(), { description: "IDs of facts picked from the fact index." }),
      ),
      facts: Type.Array(FactArgs),
      note: Type.Optional(Type.String({ description: "For not_documented: what is missing." })),
      action: Type.Optional(
        Type.String({ description: "For not_documented: one short step to close the gap." }),
      ),
    }),
    { minItems: 1 },
  ),
  leftOut: Type.Optional(
    Type.Array(
      Type.Object({
        topic: Type.String({ description: "Topic left out, at most 4 words, no value." }),
        sources: Type.Array(Cited, { minItems: 1 }),
      }),
      { description: "Documented topics this task does not need, at most 6." },
    ),
  ),
});
type ScreenArgs = Static<typeof ScreenArgs>;

function checkScreen(
  record: PatientRecord,
  args: ScreenArgs,
  index: ReadonlyMap<string, IndexedFact>,
) {
  const problems: string[] = [];
  let rejected = 0;
  const needs: Need[] = [];
  const indexedBy = new Map<string, string[]>();
  for (const fact of index.values())
    for (const s of fact.sources)
      indexedBy.set(s.passageId, [...(indexedBy.get(s.passageId) ?? []), fact.id]);
  for (const need of args.needs) {
    // An ID the index does not have (any more, after its review) is dropped rather than retried.
    const pickedIds = new Set(
      (need.factIds ?? []).map((id) => id.trim()).filter((id) => index.has(id)),
    );
    if (need.status === "not_documented") {
      if (need.facts.length > 0 || pickedIds.size > 0)
        problems.push(`Need "${need.title}" is not_documented but lists facts; pick one.`);
      needs.push({
        title: need.title,
        status: need.status,
        facts: [],
        note: need.note ?? "",
        ...(need.action?.trim() ? { action: need.action.trim() } : {}),
      });
      continue;
    }
    const facts = need.facts.flatMap((fact) => {
      const checked = verify(record, fact.sources, `"${need.title}" / "${fact.label}"`);
      const unsupported = checked.problems.length > 0;
      // With an index, screens select: a fact rewritten from indexed passages becomes those facts.
      const indexed = fact.calculation
        ? []
        : fact.sources.flatMap((s) => indexedBy.get(s.passage.trim()) ?? []);
      if (indexed.length > 0) {
        for (const id of indexed) pickedIds.add(id);
        return [];
      }
      if (SAYS_MISSING.test(`${fact.value} ${fact.detail ?? ""}`))
        checked.problems.push(
          `"${need.title}" / "${fact.label}" says something is missing; make that a not_documented need.`,
        );
      problems.push(...checked.problems);
      if (checked.problems.length === 0)
        return [{ label: fact.label, ...factParts(fact), sources: checked.sources }];
      if (unsupported) rejected++;
      return [];
    });
    const picked = [...pickedIds].flatMap((id) => {
      const fact = index.get(id);
      return fact ? [{ label: fact.label, ...factParts(fact), sources: fact.sources }] : [];
    });
    if (need.facts.length === 0 && picked.length === 0)
      problems.push(`Need "${need.title}" is documented but has no facts.`);
    const all = [...picked, ...facts];
    if (all.length > 0)
      needs.push({ title: need.title, status: need.status, facts: all, note: "" });
  }
  // A topic whose citation fails is dropped quietly: it is a pointer, not a fact on the screen.
  const leftOut = (args.leftOut ?? []).slice(0, 6).flatMap(({ topic, sources }) => {
    const checked = verify(record, sources, `leftOut "${topic}"`);
    return checked.problems.length === 0 && checked.sources.length > 0
      ? [{ topic, sources: checked.sources }]
      : [];
  });
  return { needs, leftOut, problems, rejected };
}

export function screenExtension(record: PatientRecord) {
  const submitScreen = defineTool({
    name: "submit_screen",
    description:
      "Save the clinician's screen. Every quote is checked against its passage; a failed check saves nothing and says what to fix.",
    parameters: ScreenArgs,
    // Writes only its own document, so a rerun after a crash is harmless.
    replay: "safe",
    prepareArguments: (args) => parseArrays<ScreenArgs>(args, ["needs"]),
    execute: async (args, api, context) => {
      const attempts =
        ((await api.snapshot(ScreenDoc, api.conversationId, context))?.attempts ?? 0) + 1;
      const indexed = (await api.snapshot(FactIndexDoc, context))?.facts ?? [];
      const { needs, leftOut, problems, rejected } = checkScreen(
        record,
        args,
        new Map(indexed.map((fact) => [fact.id, fact])),
      );
      const accept = problems.length === 0 || (attempts >= MAX_ATTEMPTS && needs.length > 0);
      await api.commit(async (tx) => {
        const doc = await tx.doc(ScreenDoc, api.conversationId);
        doc.attempts = attempts;
        if (accept)
          doc.result = {
            role: args.role,
            task: args.task,
            ...(args.occasion?.trim() ? { occasion: args.occasion.trim() } : {}),
            needs,
            leftOut,
            rejected,
          };
      }, context);
      if (!accept) return { isError: true, output: [{ type: "text", text: retryText(problems) }] };
      return { output: [{ type: "text", text: "Screen saved." }], control: { terminate: true } };
    },
  });
  return defineExtension({
    name: "screen",
    tools: [submitScreen],
    sections: [section("screen_rules", () => SCREEN_RULES)],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) =>
          (await api.snapshot(ScreenDoc, api.conversationId, context))?.result
            ? undefined
            : {
                continue: "Call submit_screen with the complete screen now. Do not answer in text.",
              },
      }),
    ],
  });
}

export const CONTRADICTION_RULES = `You check this patient's documents for contradictions: two or more passages that cannot all be true.

Look for, among others:
- two different dates for the same event (an admission, a discharge, a biopsy, an examination), within one document or across documents, and impossible dates;
- a BMI that does not match the height and weight in the same document (BMI = kg / m²; flag a difference above 1);
- the same finding described differently in two places, such as its side, size, severity, or whether it is present at all.

These are not contradictions: small measurement differences (165 cm and 166 cm, 140/90 and 145/90 mmHg), values that changed over time (a weight or a dose in 2019 and 2020), and one passage giving more detail than another.

For each contradiction write one English sentence that names the conflicting values (with your BMI calculation where one is involved), and cite every passage involved with a verbatim quote. Report each contradiction once. Call report_contradictions once with all of them. Do not answer in text.`;

const ContradictionArgs = Type.Object({
  contradictions: Type.Array(
    Type.Object({
      summary: Type.String({ description: "One English sentence naming the conflicting values." }),
      passages: Type.Array(Cited, { minItems: 2 }),
    }),
  ),
});
type ContradictionArgs = Static<typeof ContradictionArgs>;

export function contradictionsExtension(record: PatientRecord) {
  const report = defineTool({
    name: "report_contradictions",
    description:
      "Save the contradictions found. Every quote is checked against its passage; a failed check saves nothing and says what to fix.",
    parameters: ContradictionArgs,
    replay: "safe",
    prepareArguments: (args) => parseArrays<ContradictionArgs>(args, ["contradictions"]),
    execute: async (args, api, context) => {
      const saved = await api.snapshot(ContradictionsDoc, api.conversationId, context);
      const attempts = (saved?.attempts ?? 0) + 1;
      const earlier = saved?.result ?? [];
      const problems: string[] = [];
      const found: Contradiction[] = [];
      args.contradictions.forEach((item, index) => {
        const checked = verify(record, item.passages, `Contradiction ${index + 1}`);
        const distinct = new Set(checked.sources.map((source) => source.passageId)).size;
        if (checked.problems.length === 0 && distinct < 2)
          checked.problems.push(`Contradiction ${index + 1} needs two different passages.`);
        problems.push(...checked.problems);
        const restated = [...earlier, ...found].some((c) =>
          checked.sources.every((s) => c.passages.some((p) => p.passageId === s.passageId)),
        );
        if (checked.problems.length === 0 && !restated)
          found.push({
            id: `c${earlier.length + found.length + 1}`,
            summary: item.summary,
            passages: checked.sources,
          });
      });
      const accept = problems.length === 0 || attempts >= MAX_ATTEMPTS;
      await api.commit(async (tx) => {
        const doc = await tx.doc(ContradictionsDoc, api.conversationId);
        doc.attempts = attempts;
        if (!accept) return;
        doc.result = [...earlier, ...found];
        doc.passes = doc.wanted;
      }, context);
      if (!accept) return { isError: true, output: [{ type: "text", text: retryText(problems) }] };
      return { output: [{ type: "text", text: "Saved." }], control: { terminate: true } };
    },
  });
  return defineExtension({
    name: "contradictions",
    tools: [report],
    sections: [section("contradiction_rules", () => CONTRADICTION_RULES)],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) => {
          const doc = await api.snapshot(ContradictionsDoc, api.conversationId, context);
          return doc && doc.passes >= doc.wanted
            ? undefined
            : { continue: "Call report_contradictions now. Do not answer in text." };
        },
      }),
    ],
  });
}
