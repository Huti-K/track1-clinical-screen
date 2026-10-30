import type {
  AssessedNeed,
  Clarification,
  ClarifyFrom,
  Contradiction,
  Fact,
  SafetyCheck,
} from "@track1/shared";
import { monthName, monthsBetween, STALE_AFTER_MONTHS } from "./assess.js";
import type { Kind, Measurement } from "./measurements.js";

/** Values worth measuring again when the latest is old; height stays, and BMI follows weight. */
const REMEASURE: Partial<Record<Kind, string>> = {
  weight: "Weight",
  bp: "BP",
  hba1c: "HbA1c",
  lvef: "LVEF",
};

/** A step another clinician, department or document closes, such as the GP's report. */
const RECORDS =
  /\b(GP|general practitioner|family doctor|hospital|clinic|department|surgeon|cardiolog\w*|radiolog\w*|neurolog\w*|ophthalmolog\w*|oncolog\w*|patholog\w*|vascular|colleague|referr\w*|request|obtain|retrieve|locate|reports?|letters?|records?)\b/i;
const PATIENT = /\b(ask|patient|her|she|him|he|his)\b/i;
const TEST =
  /\b(order|measure|check|test|repeat|draw|perform|labs?|bloods?|ECG|EKG|echo\w*|TTE|x-?ray|CT|MRI|ultrasound|duplex|sonograph\w*|creatinine|eGFR|CBC|coagulation|INR|HbA1c|potassium|electrolytes)\b/i;

/** Who can close a gap, read from the step the screen gives for it. */
function fromOf(step: string): ClarifyFrom {
  if (RECORDS.test(step)) return "records";
  if (PATIENT.test(step)) return "patient";
  if (TEST.test(step)) return "test";
  return "records";
}

/** Words that do not tell topics apart, so "Blood tests" and "Blood thinners" stay two points. */
const GENERIC = new Set([
  "blood",
  "function",
  "test",
  "history",
  "status",
  "value",
  "level",
  "result",
  "follow",
  "earlier",
  "prior",
  "current",
  "latest",
]);

/** The words that name a topic, so "Kidneys" and "Kidney function" are one point. */
function topicWords(topic: string): Set<string> {
  return new Set(
    topic
      .toLowerCase()
      .split(/[^a-zäöüß0-9]+/)
      .map((word) => word.replace(/ies$/, "y").replace(/s$/, ""))
      .filter((word) => word.length >= 3 && !GENERIC.has(word)),
  );
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * What the screen leaves open, each with one step that would close it and who can close it: the
 * fixed checks' gaps, then the needs no document has, then contradictions in passages the screen
 * cites, then measurements the screen shows whose latest value in any document is old.
 */
export function clarifications(input: {
  needs: readonly AssessedNeed[];
  checks: readonly SafetyCheck[];
  contradictions: readonly (Contradiction & { relevant: boolean })[];
  measurements: readonly Measurement[];
  asOf: string;
}): Clarification[] {
  const { needs, checks, contradictions, measurements, asOf } = input;
  const gaps: Clarification[] = [];
  const named: Set<string>[] = [];
  const addGap = (id: string, topic: string, reason: string, step: string) => {
    const words = topicWords(topic);
    if (named.some((seen) => [...words].some((word) => seen.has(word)))) return;
    named.push(words);
    gaps.push({ id, topic, reason, step, from: fromOf(step), trigger: "gap", sources: [] });
  };
  for (const check of checks)
    for (const gap of check.gaps)
      addGap(`check-${check.kind}-${slug(gap.title)}`, gap.title, gap.note, gap.action);
  for (const need of needs)
    if (need.status === "not_documented")
      addGap(
        `gap-${slug(need.title)}`,
        need.title,
        need.note || "No document contains this.",
        need.action || "Ask the patient or request the records",
      );

  const facts: Fact[] = [...needs.flatMap((n) => n.facts), ...checks.flatMap((c) => c.items)];
  const conflicts = contradictions
    .filter((c) => c.relevant)
    .map((c): Clarification => {
      const ids = new Set(c.passages.map((p) => p.passageId));
      const fact = facts.find((f) => f.sources.some((s) => ids.has(s.passageId)));
      return {
        id: `contradiction-${c.id}`,
        topic: fact?.label ?? "Contradiction",
        reason: c.summary,
        step: "Check which is right",
        from: "records",
        trigger: "contradiction",
        sources: c.passages,
        contradictionId: c.id,
      };
    });

  const cited = new Set(facts.flatMap((f) => f.sources.map((s) => s.passageId)));
  const shown = new Set(
    measurements.filter((m) => cited.has(m.source.passageId)).map((m) => m.kind),
  );
  const old = Object.entries(REMEASURE).flatMap(([kind, label]): Clarification[] => {
    if (!shown.has(kind as Kind)) return [];
    const latest = measurements
      .filter((m) => m.kind === kind)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    if (!latest) return [];
    const months = monthsBetween(latest.date, asOf);
    if (months <= STALE_AFTER_MONTHS) return [];
    return [
      {
        id: `old-${kind}`,
        topic: label,
        reason: `Latest ${label} ${latest.display} is from ${monthName(latest.date)}; no document since has one.`,
        step: "Measure again if a current value is needed",
        from: "test",
        trigger: "old",
        sources: [latest.source],
      },
    ];
  });

  return [...gaps, ...conflicts, ...old];
}
