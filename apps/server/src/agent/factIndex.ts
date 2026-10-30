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
import type { Drug, Fact } from "@track1/shared";
import { Cited, MAX_ATTEMPTS, parseArrays, retryText, verify } from "./citations.js";

const CATEGORIES = [
  "diagnosis",
  "medication",
  "allergy",
  "measurement",
  "finding",
  "event",
  "plan",
  "other",
] as const;

export type IndexedFact = Fact & { id: string; category: string; date: string };

/**
 * The facts a screen picked from the index, each with its category there. A picked fact keeps the
 * indexed label and sources, which find it; screens cached before facts carried one get it too.
 */
export function withCategories<T extends { facts: Fact[] }>(
  needs: T[],
  index: readonly IndexedFact[],
): T[] {
  const key = (f: Fact) => `${f.label}\n${f.sources.map((s) => s.passageId).join(",")}`;
  const categories = new Map(index.map((f) => [key(f), f.category]));
  return needs.map((need) => ({
    ...need,
    facts: need.facts.map((fact) => {
      const category = fact.category ?? categories.get(key(fact));
      return category ? { ...fact, category } : fact;
    }),
  }));
}

/** A drug line cut into its parts, as the medication table shows it. */
export const DrugParts = Type.Object({
  name: Type.String({ description: "Generic name in English, such as 'Aspirin'." }),
  brand: Type.Optional(Type.String({ description: "Brand as written, such as 'Thrombo ASS'." })),
  dose: Type.Optional(Type.String({ description: "One intake, such as '100 mg'." })),
  schedule: Type.Optional(
    Type.String({ description: "Morning-midday-evening, such as '1-0-1', or 'weekly'." }),
  ),
  route: Type.Optional(Type.String({ description: "Such as 'oral' or 'subcutaneous'." })),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Only the parts that hold text, trimmed: the store keeps JSON, which has no undefined. */
function present<T extends Record<string, string | undefined>>(parts: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(parts).flatMap(([key, value]) => (value?.trim() ? [[key, value.trim()]] : [])),
  ) as Partial<T>;
}

/** A fact's value with its detail, date and drug parts, as the model gave them, without empty ones. */
export function factParts(fact: {
  value: string;
  detail?: string;
  date?: string;
  drug?: Static<typeof DrugParts>;
}): Pick<Fact, "value" | "detail" | "date" | "drug"> {
  const drug = fact.drug ? present(fact.drug) : undefined;
  return {
    value: fact.value.trim(),
    ...present({ detail: fact.detail }),
    ...(fact.date && DATE.test(fact.date.trim()) ? { date: fact.date.trim() } : {}),
    ...(drug?.name ? { drug: drug as Drug } : {}),
  };
}

/** How a prompt lists a fact: its value, then its detail and drug parts where it has them. */
export function factText(fact: Pick<Fact, "value" | "detail" | "drug">): string {
  const drug = fact.drug
    ? ` [drug: ${[fact.drug.name, fact.drug.brand, fact.drug.dose, fact.drug.schedule, fact.drug.route].filter(Boolean).join(", ")}]`
    : "";
  return `${fact.value}${fact.detail ? ` — ${fact.detail}` : ""}${drug}`;
}

/**
 * Every fact of the record, extracted once per store with its sources checked. Screens pick from
 * it by ID instead of writing each fact out, which is most of a screen's output.
 */
export const FactIndexDoc = defineDoc<{
  conversationId: number;
  /** The prompt and model that built it; a change builds it again. */
  request: string;
  attempts: number;
  facts: IndexedFact[] | null;
}>({
  kind: "track1.fact-index",
  version: 1,
  scope: "session",
  initial: () => ({ conversationId: 0, request: "", attempts: 0, facts: null }),
  checkpointWhen: () => true,
});

export const INDEX_RULES = `You build an index of every clinically relevant fact in this patient's documents, so that later screens can pick facts from it instead of reading the documents again.

Go through every document and every passage. Categories:
- diagnosis: diagnoses with their status (current, suspected, ruled out, past), histology, stage, receptor status and other markers;
- medication: one entry per drug and document, with dose, route and schedule written morning-midday-evening, so the table row "1 0 1 0" is 1-0-1, and its parts in drug;
- allergy: one entry per agent, with the agent as the value, such as "Contrast media", and the reaction it caused as the detail;
- measurement: vital signs, height, weight, BMI, laboratory values, ejection fraction and other numbers;
- finding: results of examinations and imaging, with side and severity;
- event: admissions, discharges, episodes and procedures that took place;
- plan: recommendations, planned procedures and follow-ups;
- other: anything else clinically relevant, such as family history or risk factors.

Each fact has its category, a label of at most 2 words, a value, a detail and the date it refers to (YYYY-MM-DD, the document's date when the passage gives none). Write like a clinician's chart, with the standard abbreviations such as HbA1c, LVEF, BP, HR, BMI, eGFR, ECG, TTE, HTN, T2DM, OSA, GERD and SLE instead of their full terms. The value is the answer in at most 4 words, such as "60 %", "Grade II", "Left" or "Aspirin 100 mg"; the detail says what qualifies it in at most 6 words, such as "TTE, normal systolic" or "1-0-0, oral", and stays empty when there is nothing to add. When the answer is a number, the value is the number with what it measures, such as "LVEF 60 %" or "HbA1c 7.2 %". A medication fact also has drug: the generic name in English, the brand as written, the dose of one intake, the schedule and the route. A value repeated in another document gets its own entry with that date; never merge different dates. Each source is a passage ID and a short verbatim quote of that passage; every claim in a value, detail or drug part needs a quote that says it. Translate German terms and add generic names to brand names, but never add anything the passage does not say. Skip addresses, signatures and empty headings.

Call submit_index once with all facts. Do not answer in text.`;

const IndexArgs = Type.Object({
  facts: Type.Array(
    Type.Object({
      category: Type.Union(CATEGORIES.map((c) => Type.Literal(c))),
      label: Type.String({ description: "Short English label, such as 'Candesartan'." }),
      value: Type.String({ description: "The answer in at most 6 words, such as '60 %'." }),
      detail: Type.Optional(
        Type.String({ description: "What qualifies the value, at most 15 words, or empty." }),
      ),
      date: Type.String({ description: "YYYY-MM-DD the fact refers to." }),
      drug: Type.Optional(DrugParts),
      sources: Type.Array(Cited, { minItems: 1 }),
    }),
    { minItems: 1 },
  ),
});
type IndexArgs = Static<typeof IndexArgs>;

export function indexExtension(record: PatientRecord) {
  const submitIndex = defineTool({
    name: "submit_index",
    description:
      "Save the fact index. Every quote is checked against its passage; a failed check saves nothing and says what to fix.",
    parameters: IndexArgs,
    replay: "safe",
    prepareArguments: (args) => parseArrays<IndexArgs>(args, ["facts"]),
    execute: async (args, api, context) => {
      const attempts = ((await api.snapshot(FactIndexDoc, context))?.attempts ?? 0) + 1;
      const problems: string[] = [];
      const facts: IndexedFact[] = [];
      for (const fact of args.facts) {
        const checked = verify(record, fact.sources, `"${fact.label}" (${fact.date})`);
        problems.push(...checked.problems);
        if (checked.problems.length === 0)
          facts.push({
            id: `f${facts.length + 1}`,
            category: fact.category,
            label: fact.label,
            ...factParts(fact),
            date: fact.date,
            sources: checked.sources,
          });
      }
      const accept = problems.length === 0 || attempts >= MAX_ATTEMPTS;
      await api.commit(async (tx) => {
        const doc = await tx.doc(FactIndexDoc);
        doc.attempts = attempts;
        if (accept) doc.facts = facts;
      }, context);
      if (!accept) return { isError: true, output: [{ type: "text", text: retryText(problems) }] };
      return { output: [{ type: "text", text: "Saved." }], control: { terminate: true } };
    },
  });
  return defineExtension({
    name: "fact-index-builder",
    tools: [submitIndex],
    sections: [section("index_rules", () => INDEX_RULES)],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) =>
          (await api.snapshot(FactIndexDoc, context))?.facts
            ? undefined
            : { continue: "Call submit_index now. Do not answer in text." },
      }),
    ],
  });
}

function indexText(facts: readonly IndexedFact[]): string {
  const order = (c: string) => CATEGORIES.indexOf(c as (typeof CATEGORIES)[number]);
  const sorted = [...facts].sort(
    (a, b) => order(a.category) - order(b.category) || b.date.localeCompare(a.date),
  );
  return [
    "Facts already extracted from the documents, with checked sources: [fact ID] category date | label | value | passages.",
    "Pick facts for the screen by their ID in factIds; a picked fact keeps its label, value, detail, date, drug parts and sources. Write a fact of your own under facts only for a calculation such as a weight change (set calculation, cite every input) or for a passage no indexed fact cites.",
    "",
    ...sorted.map(
      (f) =>
        `[${f.id}] ${f.category} ${f.date} | ${f.label} | ${factText(f)} | ${f.sources.map((s) => s.passageId).join(", ")}`,
    ),
  ].join("\n");
}

/** The review of the index: whether each value says only what its passages say. */
export const FactReviewDoc = defineDoc<{
  conversationId: number;
  /** The index request and review prompt it checked; a change reviews again. */
  request: string;
  attempts: number;
  done: boolean;
  corrected: number;
  dropped: number;
}>({
  kind: "track1.fact-review",
  version: 1,
  scope: "session",
  initial: () => ({
    conversationId: 0,
    request: "",
    attempts: 0,
    done: false,
    corrected: 0,
    dropped: 0,
  }),
  checkpointWhen: () => true,
});

export const REVIEW_RULES = `You check an index of facts extracted from German clinical documents. Each fact shows its English value, the detail after a dash and the drug parts in brackets where it has them, the quotes it rests on and the full text of the cited passages with their document's date. Decide for every fact whether value, detail and drug parts say only what its passages say.

- supported: every claim, including numbers, dates, sides, doses, schedules and the time it refers to, is in the cited passages. Translation, generic drug names, a schedule written as 1-0-1 and the document's date for an undated passage are fine.
- corrected: the value or detail claims something the passages do not say or gets a detail wrong. Give a corrected value of at most 6 words and a corrected detail that say only what the passages say: drop or fix the wrong claim, and never add a remark about what the passages leave out.
- unsupported: the passages do not support the fact at all.

Call submit_review once with a verdict for every fact. Do not answer in text.`;

function reviewText(record: PatientRecord, facts: readonly IndexedFact[]): string {
  return facts
    .map((f) =>
      [
        `[${f.id}] ${f.category} ${f.date} | ${f.label} | ${factText(f)}`,
        ...f.sources.map((s) => {
          const passage = record.passage(s.passageId);
          return `  quote "${s.quote}" from [${s.passageId}] (${s.documentTitle}, ${s.documentDate}): ${passage?.text ?? ""}`;
        }),
      ].join("\n"),
    )
    .join("\n");
}

const ReviewArgs = Type.Object({
  reviews: Type.Array(
    Type.Object({
      id: Type.String({ description: "Fact ID, such as f12." }),
      verdict: Type.Union([
        Type.Literal("supported"),
        Type.Literal("corrected"),
        Type.Literal("unsupported"),
      ]),
      value: Type.Optional(Type.String({ description: "For corrected: the corrected value." })),
      detail: Type.Optional(
        Type.String({ description: "For corrected: the corrected detail, empty for none." }),
      ),
    }),
  ),
});
type ReviewArgs = Static<typeof ReviewArgs>;

/** A corrected fact: the reviewer's value, and its detail when it gave one; empty drops the detail. */
function corrected(fact: IndexedFact, value: string, detail: string | undefined): IndexedFact {
  if (detail === undefined) return { ...fact, value: value.trim() };
  const { detail: _replaced, ...rest } = fact;
  return { ...rest, value: value.trim(), ...(detail.trim() ? { detail: detail.trim() } : {}) };
}

/** Checks every index value against its passages and applies the verdicts to the index. */
export function reviewExtension(record: PatientRecord) {
  const submitReview = defineTool({
    name: "submit_review",
    description:
      "Save a verdict for every fact. Corrected values replace the old ones and unsupported facts leave the index.",
    parameters: ReviewArgs,
    replay: "safe",
    prepareArguments: (args) => parseArrays<ReviewArgs>(args, ["reviews"]),
    execute: async (args, api, context) => {
      const attempts = ((await api.snapshot(FactReviewDoc, context))?.attempts ?? 0) + 1;
      const facts = (await api.snapshot(FactIndexDoc, context))?.facts ?? [];
      const verdicts = new Map(args.reviews.map((r) => [r.id.trim(), r]));
      const problems = [
        ...facts.filter((f) => !verdicts.has(f.id)).map((f) => `No verdict for ${f.id}.`),
        ...args.reviews
          .filter((r) => r.verdict === "corrected" && !r.value?.trim())
          .map((r) => `${r.id} is corrected but has no value.`),
      ];
      const accept = problems.length === 0 || attempts >= MAX_ATTEMPTS;
      await api.commit(async (tx) => {
        const review = await tx.doc(FactReviewDoc);
        review.attempts = attempts;
        if (!accept) return;
        // A fact without a verdict after the last attempt stays as it was.
        const kept = facts.flatMap((fact) => {
          const verdict = verdicts.get(fact.id);
          if (verdict?.verdict === "unsupported") return [];
          if (verdict?.verdict === "corrected" && verdict.value?.trim())
            return [corrected(fact, verdict.value, verdict.detail)];
          return [fact];
        });
        Object.assign(review, {
          done: true,
          corrected: args.reviews.filter((r) => r.verdict === "corrected").length,
          dropped: facts.length - kept.length,
        });
        (await tx.doc(FactIndexDoc)).facts = kept;
      }, context);
      if (!accept)
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `Nothing was saved. Fix these and call submit_review again:\n- ${problems.join("\n- ")}`,
            },
          ],
        };
      return { output: [{ type: "text", text: "Saved." }], control: { terminate: true } };
    },
  });
  return defineExtension({
    name: "fact-review",
    tools: [submitReview],
    sections: [
      section("review_rules", () => REVIEW_RULES),
      section("facts_to_review", async (input, context) => {
        const facts = (await input.read.snapshot(FactIndexDoc, context))?.facts;
        return facts ? reviewText(record, facts) : undefined;
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        onYield: async (_answer, api, context) =>
          (await api.snapshot(FactReviewDoc, context))?.done
            ? undefined
            : { continue: "Call submit_review now. Do not answer in text." },
      }),
    ],
  });
}

/** The index as a prompt section for screens, read from the store at each request. */
export const factIndexSection = defineExtension({
  name: "fact-index",
  sections: [
    section("fact_index", async (input, context) => {
      const facts = (await input.read.snapshot(FactIndexDoc, context))?.facts;
      return facts ? indexText(facts) : undefined;
    }),
  ],
});
