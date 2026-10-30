import type { PatientRecord } from "@track1/patient-record";
import type { AssessedFact, Basics, Contradiction, Drug, Fact, Passage } from "@track1/shared";
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
const MEDICATION = /medikation/i;
const CELL_DOSE =
  /(\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)?)\s?(mg|mcg|µg|ug|g|ml|IE|I\.E\.)(?![a-zäöü])/i;
const SLOT = /^(?:\d+|½|¼|1\/2|1\/4)$/;

function medicationRow(
  record: PatientRecord,
  passage: Passage,
  cells: string[],
  date: string,
): Fact {
  const [written = "", route = "", ...rest] = cells;
  const dose = CELL_DOSE.exec(written);
  const name = (dose ? written.slice(0, dose.index) : written).trim();
  const slots = rest.slice(0, 4).map((slot) => slot.replace("1/2", "½").replace("1/4", "¼"));
  const timed = slots.length === 4 && slots.every((slot) => SLOT.test(slot));
  const schedule = timed
    ? (slots[3] === "0" ? slots.slice(0, 3) : slots).join("-")
    : rest.join(" ").trim();
  const drug: Drug = {
    name,
    ...(dose ? { dose: `${dose[1]?.replace(",", ".")} ${dose[2]}` } : {}),
    ...(schedule ? { schedule } : {}),
    ...(route ? { route } : {}),
  };
  return {
    label: name,
    value: [name, drug.dose].filter(Boolean).join(" "),
    date,
    drug,
    sources: [sourceOf(record, passage, passage.text)],
  };
}

function medication(record: PatientRecord, index: readonly IndexedFact[]): Fact[] {
  const latest = record.documents
    .flatMap((doc) =>
      (doc.layout ?? []).flatMap((block) =>
        block.kind === "table" &&
        block.rows.some((row) => MEDICATION.test(record.passage(row.passageId)?.section ?? ""))
          ? [{ date: doc.date, rows: block.rows }]
          : [],
      ),
    )
    .at(-1);
  if (!latest) return [];
  return latest.rows.flatMap((row) => {
    const passage = record.passage(row.passageId);
    if (!passage) return [];
    const indexed = index.find(
      (f) => f.category === "medication" && f.sources.some((s) => s.passageId === passage.id),
    );
    if (!indexed) return [medicationRow(record, passage, row.cells, latest.date)];
    const { label, value, detail, date, drug, sources } = indexed;
    return [
      { label, value, ...(detail ? { detail } : {}), date, ...(drug ? { drug } : {}), sources },
    ];
  });
}

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
      category: "diagnosis",
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
    medication: assessed(medication(record, index)),
  };
}
