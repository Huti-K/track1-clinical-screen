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
import type { Fact } from "@track1/shared";
import { MAX_ATTEMPTS, parseArrays, retryText, verify } from "./citations.js";
import { FactArgs, SAYS_MISSING } from "./clinical.js";
import { factParts } from "./factIndex.js";

type AnswerResult = {
  topic: string;
  facts: Fact[];
  missing?: { note: string; action?: string };
  rejected: number;
};

export const AnswerDoc = defineDoc<{ attempts: number; result: AnswerResult | null }>({
  kind: "track1.answer",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: 0, result: null }),
  checkpointWhen: () => true,
});

export const ANSWER_RULES = `You answer one follow-up question a clinician asks about this patient's documents. The user message is the situation the clinician typed, usually their role and task, and their question, usually in English.

1. Answer only from the documents, and search all of them. Where values changed over time, give the latest with its date, and earlier ones when the question asks about them or the change matters.
2. Give up to 4 facts that answer the question, written like a clinician's chart with the standard abbreviations such as HbA1c, LVEF, BP, eGFR, ECG and TTE. Every fact has a label of at most 2 words, a value, a detail and the date it refers to. The value answers the label in at most 4 words, such as "60 %", "Left" or "Aspirin 100 mg"; the detail says what qualifies it in at most 6 words. When the answer is a number, the value is the number with what it measures, such as "LVEF 60 %". A drug also has its parts in drug: generic name, brand, dose of one intake, schedule and route. Translate German terms; you may add generic names to brand names and compute values such as a weight change, citing the inputs. Write medication schedules as morning-midday-evening, so the table row "1 0 1 0" is 1-0-1.
3. Each source is a passage ID and a short verbatim quote of that passage. Every claim in a value, detail or drug part needs a quote that says it; when a fact combines several passages, cite each of them.
4. When the documents do not answer the question or a part of it, say so in missing: a note of at most 8 words naming what no document contains, such as "No echocardiogram after March 2019", and an action: one step of at most 5 words that would close the gap, such as "Ask the patient" or "Request the duplex report". A fact never says that something is missing. Never fill a gap from general knowledge. A question that is not about this patient gets no facts and the note "Not a question about her documents".
5. State only what the documents say. No advice and no recommendations of your own, except the action in missing.
6. Give the answer a topic of at most 4 words, such as "Carotid duplex follow-up".
7. Call submit_answer once with the complete answer. Do not answer in text.`;

const AnswerArgs = Type.Object({
  topic: Type.String({ description: "What the answer is about, at most 4 words." }),
  facts: Type.Array(FactArgs, {
    description: "Up to 4 facts that answer the question; empty when no document does.",
  }),
  missing: Type.Optional(
    Type.Object({
      note: Type.String({ description: "What no document contains, at most 8 words." }),
      action: Type.Optional(
        Type.String({ description: "One step of at most 5 words that would close the gap." }),
      ),
    }),
  ),
});
type AnswerArgs = Static<typeof AnswerArgs>;

function checkAnswer(record: PatientRecord, args: AnswerArgs) {
  const problems: string[] = [];
  let rejected = 0;
  const facts = args.facts.flatMap((fact) => {
    const checked = verify(record, fact.sources, `"${fact.label}"`);
    const unsupported = checked.problems.length > 0;
    if (SAYS_MISSING.test(`${fact.value} ${fact.detail ?? ""}`))
      checked.problems.push(
        `"${fact.label}" says something is missing; say that in missing instead of a fact.`,
      );
    problems.push(...checked.problems);
    if (checked.problems.length === 0)
      return [{ label: fact.label, ...factParts(fact), sources: checked.sources }];
    if (unsupported) rejected++;
    return [];
  });
  const note = args.missing?.note.trim();
  const action = args.missing?.action?.trim();
  if (args.facts.length === 0 && !note)
    problems.push("Give facts that answer the question, or say in missing what no document has.");
  const result: AnswerResult = {
    topic: args.topic.trim(),
    facts,
    ...(note ? { missing: { note, ...(action ? { action } : {}) } } : {}),
    rejected,
  };
  return { result, problems };
}

export function answerExtension(record: PatientRecord) {
  const submitAnswer = defineTool({
    name: "submit_answer",
    description:
      "Save the answer. Every quote is checked against its passage; a failed check saves nothing and says what to fix.",
    parameters: AnswerArgs,
    // Writes only its own document, so a rerun after a crash is harmless.
    replay: "safe",
    prepareArguments: (args) => parseArrays<AnswerArgs>(args, ["facts"]),
    execute: async (args, api, context) => {
      const attempts =
        ((await api.snapshot(AnswerDoc, api.conversationId, context))?.attempts ?? 0) + 1;
      const { result, problems } = checkAnswer(record, args);
      const accept = problems.length === 0 || attempts >= MAX_ATTEMPTS;
      await api.commit(async (tx) => {
        const doc = await tx.doc(AnswerDoc, api.conversationId);
        doc.attempts = attempts;
        if (accept) doc.result = result;
      }, context);
      if (!accept) return { isError: true, output: [{ type: "text", text: retryText(problems) }] };
      return { output: [{ type: "text", text: "Answer saved." }], control: { terminate: true } };
    },
  });
  return defineExtension({
    name: "answer",
    tools: [submitAnswer],
    sections: [section("answer_rules", () => ANSWER_RULES)],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) =>
          (await api.snapshot(AnswerDoc, api.conversationId, context))?.result
            ? undefined
            : {
                continue: "Call submit_answer with the complete answer now. Do not answer in text.",
              },
      }),
    ],
  });
}
