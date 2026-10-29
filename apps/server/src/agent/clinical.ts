import { type Static, Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";
import { type PatientRecord, passageSays } from "@track1/patient-record";
import type { Contradiction, Need, Source } from "@track1/shared";

/** After this many rejected submissions the tool keeps what checks out and drops the rest. */
const MAX_ATTEMPTS = 3;

export const ScreenDoc = defineDoc<{
  attempts: number;
  result: { role: string; task: string; needs: Need[]; rejected: number } | null;
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
}>({
  kind: "track1.contradictions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: 0, result: null }),
  checkpointWhen: () => true,
});

const Cited = Type.Object({
  passage: Type.String({ description: "Passage ID, such as 12340012-37." }),
  quote: Type.String({
    description:
      "The words in that passage that carry the fact, copied verbatim in the document's language.",
  }),
});
type CitedArg = Static<typeof Cited>;

/** Each cited passage that exists and says its quote; a problem line for each that does not. */
function verify(record: PatientRecord, cited: readonly CitedArg[], where: string) {
  const sources: Source[] = [];
  const problems: string[] = [];
  for (const { passage: id, quote } of cited) {
    const passage = record.passage(id.trim());
    const document = passage && record.document(passage.documentId);
    if (!passage || !document) problems.push(`${where}: passage ${id} does not exist.`);
    else if (!passageSays(passage.text, quote))
      problems.push(`${where}: "${quote}" is not in ${id}, which reads: "${passage.text}"`);
    else
      sources.push({
        passageId: passage.id,
        documentId: document.id,
        documentTitle: document.title,
        documentDate: document.date,
        quote: quote.trim(),
      });
  }
  return { sources, problems };
}

function retryText(problems: string[]): string {
  return [
    "Nothing was saved. Fix these citations and call the tool again with the complete result:",
    ...problems.map((problem) => `- ${problem}`),
    "Quote only words that are in the cited passage, or cite the passage that says them.",
  ].join("\n");
}

/** Models sometimes send an array argument as a JSON string. */
function parseArrays<T>(args: unknown, keys: readonly string[]): T {
  if (typeof args !== "object" || args === null) return args as T;
  const fixed: Record<string, unknown> = { ...args };
  for (const key of keys) {
    const value = fixed[key];
    if (typeof value !== "string") continue;
    try {
      fixed[key] = JSON.parse(value);
    } catch {
      // Left as is; validation reports it to the model.
    }
  }
  return fixed as T;
}

function recordText(record: PatientRecord): string {
  const { summary } = record;
  const header = [
    `Patient: ${summary.name}, ${summary.sex}, born ${summary.dateOfBirth}.`,
    `The documents call her "Beispielpatientin" or "NN_${summary.id}". The latest document is from ${summary.asOf}; she was ${summary.ageAsOf} then. Present tense means as of that date.`,
    "Every line below is one passage: [passage ID] text. Cite passages by their ID.",
  ];
  const documents = record.documents.map((doc) =>
    [
      `=== Document ${doc.id} | ${doc.date} | ${doc.title} | ${doc.type} | ${doc.department}`,
      ...doc.passages.map((p) => `[${p.id}] ${p.text}`),
    ].join("\n"),
  );
  return [...header, "", ...documents].join("\n");
}

/** The whole record as the first prompt section: identical for every conversation, so providers cache it. */
export function recordExtension(record: PatientRecord) {
  const text = recordText(record);
  return defineExtension({
    name: "patient-record",
    sections: [section("patient_record", () => text)],
  });
}

export const SCREEN_RULES = `You prepare one screen for a clinician: only the facts from this patient's documents that their role and task need. The user message is the situation the clinician typed, usually their role and task in English.

1. Decide what this clinician needs for this task: 4 to 7 needs. Anticipate their questions: what happened before and what caused it, the medication that matters for the task with doses, allergies and contraindications for the likely interventions, the latest relevant measurements with their dates, planned procedures, recommended follow-ups and whether they took place. Leave out what does not matter for this task, such as tumour receptor status for an anaesthetist.
2. Search all documents for every need. Where values changed over time, give the latest one with its date, and earlier ones when the change matters (for example a weight trend).
3. It must fit one screen: at most 3 facts per need and about 15 facts in all. Every fact has a short English label and a short English value (at most 20 words) with its date. Translate German terms; you may add generic drug names to brand names and compute values such as a weight change, citing the inputs. Write medication schedules as morning-midday-evening, so the table row "1 0 1 0" is 1-0-1.
4. Each source is a passage ID and a short verbatim quote (a few words) of that passage. Every claim in a value must be in the quotes of its sources; cite one passage per claim, the most recent that says it, and every input of a calculation.
5. When the documents do not contain something the task needs, add that need with status "not_documented", no facts, and a short note saying what is missing (for example "No creatinine or eGFR in any document"). Never fill a gap from general knowledge.
6. State only what the documents say. No advice and no recommendations of your own.
7. Call submit_screen once with the complete screen. Do not answer in text.`;

const Fact = Type.Object({
  label: Type.String({ description: "Short English label, such as 'Antiplatelet'." }),
  value: Type.String({
    description: "English value with dose and date where the record has them.",
  }),
  sources: Type.Array(Cited, { minItems: 1 }),
});

const ScreenArgs = Type.Object({
  role: Type.String({ description: "The clinician's role in English, at most 4 words." }),
  task: Type.String({ description: "The task in English, at most 8 words." }),
  needs: Type.Array(
    Type.Object({
      title: Type.String({ description: "What the task needs, such as 'Blood thinners'." }),
      status: Type.Union([Type.Literal("documented"), Type.Literal("not_documented")]),
      facts: Type.Array(Fact),
      note: Type.Optional(Type.String({ description: "For not_documented: what is missing." })),
    }),
    { minItems: 1 },
  ),
});
type ScreenArgs = Static<typeof ScreenArgs>;

function checkScreen(record: PatientRecord, args: ScreenArgs) {
  const problems: string[] = [];
  let rejected = 0;
  const needs: Need[] = [];
  for (const need of args.needs) {
    if (need.status === "not_documented") {
      if (need.facts.length > 0)
        problems.push(`Need "${need.title}" is not_documented but lists facts; pick one.`);
      needs.push({ title: need.title, status: need.status, facts: [], note: need.note ?? "" });
      continue;
    }
    const facts = need.facts.flatMap((fact) => {
      const checked = verify(record, fact.sources, `"${need.title}" / "${fact.label}"`);
      problems.push(...checked.problems);
      if (checked.problems.length === 0) return [{ ...fact, sources: checked.sources }];
      rejected++;
      return [];
    });
    if (need.facts.length === 0)
      problems.push(`Need "${need.title}" is documented but has no facts.`);
    if (facts.length > 0) needs.push({ title: need.title, status: need.status, facts, note: "" });
  }
  return { needs, problems, rejected };
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
      const { needs, problems, rejected } = checkScreen(record, args);
      const accept = problems.length === 0 || (attempts >= MAX_ATTEMPTS && needs.length > 0);
      await api.commit(async (tx) => {
        const doc = await tx.doc(ScreenDoc, api.conversationId);
        doc.attempts = attempts;
        if (accept) doc.result = { role: args.role, task: args.task, needs, rejected };
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
- left and right swapped for the same finding;
- a BMI that does not match the height and weight in the same document (BMI = kg / m²; flag a difference above 1);
- findings about the same thing at the same time that exclude each other, such as enlarged and not enlarged lymph nodes.

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
      const attempts =
        ((await api.snapshot(ContradictionsDoc, api.conversationId, context))?.attempts ?? 0) + 1;
      const problems: string[] = [];
      const found: Contradiction[] = [];
      args.contradictions.forEach((item, index) => {
        const checked = verify(record, item.passages, `Contradiction ${index + 1}`);
        const distinct = new Set(checked.sources.map((source) => source.passageId)).size;
        if (checked.problems.length === 0 && distinct < 2)
          checked.problems.push(`Contradiction ${index + 1} needs two different passages.`);
        problems.push(...checked.problems);
        if (checked.problems.length === 0)
          found.push({
            id: `c${found.length + 1}`,
            summary: item.summary,
            passages: checked.sources,
          });
      });
      const accept = problems.length === 0 || attempts >= MAX_ATTEMPTS;
      await api.commit(async (tx) => {
        const doc = await tx.doc(ContradictionsDoc, api.conversationId);
        doc.attempts = attempts;
        if (accept) doc.result = found;
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
        onYield: async (_answer, api, context) =>
          (await api.snapshot(ContradictionsDoc, api.conversationId, context))?.result
            ? undefined
            : { continue: "Call report_contradictions now. Do not answer in text." },
      }),
    ],
  });
}
