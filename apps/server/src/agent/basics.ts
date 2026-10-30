import type { PatientRecord } from "@track1/patient-record";
import type { AssessedFact, Basics, Contradiction, Fact } from "@track1/shared";
import { assess } from "./assess.js";
import type { IndexedFact } from "./factIndex.js";
import { type Kind, type Measurement, sourceOf } from "./measurements.js";

const BODY: { kind: Kind; label: string }[] = [
  { kind: "height", label: "Height" },
  { kind: "weight", label: "Weight" },
  { kind: "bmi", label: "BMI" },
];

/** An allergy line as the letters write it, such as `KM-Allergie (Übelkeit)` or `Allergien: keine`. */
const ALLERGY = /allergi|unverträglichkeit|intoleranz|\bCAVE\b/i;
/** A heading such as `Allergien:`, which names the topic but says nothing about it. */
const HEADING = /^[^:]{1,40}:$/;
/** Words that do not tell one allergy from another, so "Contrast allergy" and "Contrast media" are one. */
const ALLERGY_WORDS = /\b(allerg\w*|media|medium|agents?|reactions?|intoleran\w*)\b/gi;
/** A diagnosis the documents rule out or only suspect is no problem the patient has. */
const NOT_A_PROBLEM = /ruled out|excluded|suspected|unlikely|ausgeschlossen|verdacht|\bV\.\s?a\./i;
const MAX_PROBLEMS = 12;

const newestFirst = (a: { date?: string }, b: { date?: string }) =>
  (b.date ?? "").localeCompare(a.date ?? "");

const firstWord = (text: string) => text.trim().split(/\s/)[0]?.toLowerCase() ?? "";

/** Which allergy a fact names: its label without the generic words, else its value's first word. */
const allergyKey = (fact: Fact) =>
  fact.label.replace(ALLERGY_WORDS, "").trim().toLowerCase() ||
  firstWord(fact.value.replace(ALLERGY_WORDS, ""));

/** The newest fact of each group, groups in the order of their newest fact. */
function newestPerGroup<T extends { date?: string }>(
  facts: readonly T[],
  key: (fact: T) => string,
) {
  const groups = new Map<string, T[]>();
  for (const fact of [...facts].sort(newestFirst)) {
    const k = key(fact);
    groups.set(k, [...(groups.get(k) ?? []), fact]);
  }
  return [...groups.values()];
}

/**
 * The patient's basics for every screen: the latest height, weight and BMI any document states,
 * the documented allergies, and the diagnoses the fact index holds, those named in the most
 * documents first. Allergies come from the index, or else from the passages as the letters write them.
 */
export function basics(
  record: PatientRecord,
  measurements: readonly Measurement[],
  index: readonly IndexedFact[],
  contradictions: readonly Contradiction[],
): Basics {
  const measures = BODY.flatMap(({ kind, label }): Fact[] => {
    const latest = measurements
      .filter((m) => m.kind === kind)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    return latest
      ? [{ label, value: latest.display, date: latest.date, sources: [latest.source] }]
      : [];
  });

  const indexed = index.filter((f) => f.category === "allergy");
  const allergies: Fact[] =
    indexed.length > 0
      ? newestPerGroup(indexed, allergyKey)
          .flatMap((group) => group.slice(0, 1))
          .map(({ label, value, detail, date, sources }) => ({
            label,
            value,
            ...(detail ? { detail } : {}),
            date,
            sources,
          }))
      : newestPerGroup(
          record.documents.flatMap((doc) =>
            doc.passages
              .filter((p) => ALLERGY.test(p.text) && !HEADING.test(p.text))
              .map((p) => ({ passage: p, date: doc.date })),
          ),
          ({ passage }) => firstWord(passage.text),
        ).flatMap((group) =>
          group.slice(0, 1).map(({ passage, date }) => ({
            label: "Allergy",
            value: passage.text,
            date,
            sources: [sourceOf(record, passage, passage.text)],
          })),
        );

  const problems = newestPerGroup(
    index.filter(
      (f) =>
        f.category === "diagnosis" &&
        !NOT_A_PROBLEM.test(`${f.label} ${f.value} ${f.detail ?? ""}`),
    ),
    (f) => f.label.trim().toLowerCase(),
  )
    .map((group) => ({
      fact: group[0] as IndexedFact,
      documents: new Set(group.flatMap((f) => f.sources.map((s) => s.documentId))).size,
    }))
    .sort((a, b) => b.documents - a.documents || newestFirst(a.fact, b.fact))
    .slice(0, MAX_PROBLEMS)
    .map(({ fact: { label, value, detail, date, sources } }) => ({
      label,
      value,
      ...(detail ? { detail } : {}),
      date,
      sources,
    }));

  const assessed = (facts: Fact[]): AssessedFact[] =>
    assess(
      [{ title: "Basics", status: "documented", facts }],
      contradictions,
      record.summary.asOf,
    )[0]?.facts ?? [];
  return {
    measures: assessed(measures),
    allergies: assessed(allergies),
    problems: assessed(problems),
  };
}
