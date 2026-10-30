import type { PatientRecord } from "@track1/patient-record";
import type { Contradiction, Fact, Passage, Source, Trend, TrendPoint } from "@track1/shared";

export type Kind = "height" | "weight" | "bmi" | "hba1c" | "lvef" | "bp";

/** One value a passage states, with the words that state it. */
export type Measurement = {
  kind: Kind;
  value: number;
  display: string;
  date: string;
  source: Source;
};

const PATTERNS: { kind: Kind; pattern: RegExp; unit: string }[] = [
  { kind: "height", pattern: /\bGröße:\s*(\d{3})\s*cm\b/i, unit: "cm" },
  { kind: "weight", pattern: /\bGewicht:\s*(\d{2,3}(?:[.,]\d+)?)\s*kg\b/i, unit: "kg" },
  { kind: "bmi", pattern: /\bBMI:?\s*(\d{2}(?:[.,]\d+)?)/i, unit: "kg/m²" },
  { kind: "hba1c", pattern: /HbA1c[^\d%]{0,12}(\d{1,2}[.,]\d)\s*%/i, unit: "%" },
  { kind: "lvef", pattern: /\b(?:LV-?)?EF\s*(?:von\s*)?(\d{2})\s*%/, unit: "%" },
  {
    kind: "bp",
    pattern: /\b(?:RR|Blutdruck)(?:\s+bei\s+Aufnahme)?:\s*(\d{2,3})\/(\d{2,3})\s*mmHg/,
    unit: "mmHg",
  },
];

const TRENDS: { kind: Kind; label: string; mentions: RegExp }[] = [
  { kind: "weight", label: "Weight", mentions: /\bweight\b|gewicht/i },
  { kind: "bmi", label: "BMI", mentions: /\bBMI\b/i },
  { kind: "hba1c", label: "HbA1c", mentions: /HbA1c/i },
  { kind: "lvef", label: "LV ejection fraction", mentions: /ejection|\bLVEF\b|\bEF\b/i },
  {
    kind: "bp",
    label: "Blood pressure (systolic)",
    mentions: /blood pressure|\bmmHg\b|hypertensi/i,
  },
];

function number(text: string): number {
  return Number(text.replace(",", "."));
}

export function sourceOf(record: PatientRecord, passage: Passage, quote: string): Source {
  const document = record.document(passage.documentId);
  return {
    passageId: passage.id,
    documentId: passage.documentId,
    documentTitle: document?.title ?? passage.documentId,
    documentDate: document?.date ?? "",
    quote,
  };
}

/** Every height, weight, BMI, HbA1c, ejection fraction and blood pressure the passages state. */
export function measurements(record: PatientRecord): Measurement[] {
  return record.documents.flatMap((doc) =>
    doc.passages.flatMap((passage) =>
      PATTERNS.flatMap(({ kind, pattern, unit }) => {
        const match = pattern.exec(passage.text);
        if (!match?.[1]) return [];
        const value = number(match[1]);
        const display =
          kind === "bp"
            ? `${match[1]}/${match[2]} ${unit}`
            : `${match[1].replace(",", ".")} ${unit}`;
        return [
          { kind, value, display, date: doc.date, source: sourceOf(record, passage, match[0]) },
        ];
      }),
    ),
  );
}

function monthYear(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayMonthYear(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

/** The same value restated within a month, as a letter repeating a consult, is one point. */
function points(values: Measurement[]): TrendPoint[] {
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date));
  const merged: TrendPoint[] = [];
  for (const m of sorted) {
    const last = merged.at(-1);
    if (last && last.value === m.value && daysBetween(last.date, m.date) <= 31) {
      if (!last.sources.some((s) => s.passageId === m.source.passageId))
        last.sources.push(m.source);
    } else merged.push({ value: m.value, display: m.display, date: m.date, sources: [m.source] });
  }
  return merged;
}

/**
 * Measurements this screen is about and the record documents more than once: those a fact cites
 * or names, such as weight for a diabetes review.
 */
export function trendsFor(all: readonly Measurement[], facts: readonly Fact[]): Trend[] {
  const cited = new Set(facts.flatMap((f) => f.sources.map((s) => s.passageId)));
  const text = facts.map((f) => `${f.label} ${f.value}`).join("\n");
  return TRENDS.flatMap(({ kind, label, mentions }) => {
    const values = all.filter((m) => m.kind === kind);
    if (!values.some((m) => cited.has(m.source.passageId)) && !mentions.test(text)) return [];
    const series = points(values);
    const first = series[0];
    const last = series.at(-1);
    if (!first || !last || series.length < 2) return [];
    const unit = PATTERNS.find((p) => p.kind === kind)?.unit ?? "";
    const delta = Math.round((last.value - first.value) * 10) / 10;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    return [
      {
        kind,
        label,
        unit,
        points: series,
        change: `${sign}${Math.abs(delta)} ${unit} since ${monthYear(first.date)}`,
      },
    ];
  });
}

/** A stated BMI more than this far from weight / height² in the same document contradicts them. */
const BMI_TOLERANCE = 1;

function bmiChecks(record: PatientRecord, all: readonly Measurement[]): Contradiction[] {
  return record.documents.flatMap((doc) => {
    const of = (kind: Kind) => all.find((m) => m.kind === kind && m.source.documentId === doc.id);
    const height = of("height");
    const weight = of("weight");
    const bmi = of("bmi");
    if (!height || !weight || !bmi) return [];
    const computed = weight.value / (height.value / 100) ** 2;
    if (Math.abs(computed - bmi.value) <= BMI_TOLERANCE) return [];
    return [
      {
        id: `r-bmi-${doc.id}`,
        method: "rule",
        summary: `BMI ${bmi.value} in the ${doc.title} (${dayMonthYear(doc.date)}) does not match ${weight.value} kg at ${height.value} cm, which gives a BMI of ${computed.toFixed(1)}.`,
        passages: [bmi.source, weight.source, height.source],
      },
    ];
  });
}

type Side = "left" | "right";

const SIDES: { side: Side; pattern: RegExp }[] = [
  {
    side: "left",
    pattern: /(?:^|[\s(])(links|linke[nrsm]?|li\.|sin\.?|sinistr\w*)(?=$|[\s,.;)])/gi,
  },
  { side: "right", pattern: /(?:^|[\s(])(rechts|rechte[nrsm]?|re\.|dext\w*)(?=$|[\s,.;)])/gi },
];

/** Sentences: a full stop before a capital ends one, unless it ends an abbreviation such as `li.`. */
function clauses(text: string): { start: number; text: string }[] {
  const parts: { start: number; text: string }[] = [];
  let start = 0;
  for (const match of text.matchAll(/(\S+?)[.!?;]+\s+(?=[A-ZÄÖÜ])/g)) {
    const word = match[1] ?? "";
    if (word.length < 4 && /^[a-zäöüß]+$/i.test(word)) continue;
    const end = (match.index ?? 0) + match[0].length;
    parts.push({ start, text: text.slice(start, end) });
    start = end;
  }
  parts.push({ start, text: text.slice(start) });
  return parts;
}

type Span = { from: number; to: number };

/** The side word nearest to the artery's name, so "li. Auge … Carotis sin." reads as the artery's side. */
function sideNear(clause: string, artery: Span, percent: Span) {
  let best: { side: Side; span: Span; distance: number } | undefined;
  for (const { side, pattern } of SIDES)
    for (const match of clause.matchAll(pattern)) {
      const word = match[1] ?? "";
      const from = (match.index ?? 0) + match[0].length - word.length;
      const span = { from, to: from + word.length };
      const distance = from >= artery.to ? from - artery.to : Math.max(0, artery.from - span.to);
      if (!best || distance < best.distance) best = { side, span, distance };
    }
  if (!best) return undefined;
  const spans = [best.span, artery, percent];
  return {
    side: best.side,
    quote: clause
      .slice(Math.min(...spans.map((s) => s.from)), Math.max(...spans.map((s) => s.to)))
      .trim(),
  };
}

/** The same carotid stenosis, by its percentage, put on the left in one passage and on the right in another. */
function carotidSideChecks(record: PatientRecord): Contradiction[] {
  const bySide = new Map<string, Map<Side, Source[]>>();
  for (const doc of record.documents)
    for (const passage of doc.passages) {
      if (
        !/carotis|karotis/i.test(passage.text) ||
        !/stenose|einengung|sklerose/i.test(passage.text)
      )
        continue;
      for (const clause of clauses(passage.text)) {
        const percent = /(\d{2})\s*%/.exec(clause.text);
        const artery = /\S*(carotis|karotis)\S*/i.exec(clause.text);
        if (!percent?.[1] || !artery) continue;
        const near = sideNear(
          clause.text,
          { from: artery.index, to: artery.index + artery[0].length },
          { from: percent.index, to: percent.index + percent[0].length },
        );
        if (!near) continue;
        const sides = bySide.get(percent[1]) ?? new Map<Side, Source[]>();
        bySide.set(percent[1], sides);
        const list = sides.get(near.side) ?? [];
        if (!list.some((s) => s.passageId === passage.id))
          list.push(sourceOf(record, passage, near.quote));
        sides.set(near.side, list);
      }
    }
  return [...bySide].flatMap(([percent, sides]) => {
    const left = sides.get("left") ?? [];
    const right = sides.get("right") ?? [];
    if (!left.length || !right.length) return [];
    const [major, minor, majorSide, minorSide] =
      left.length >= right.length ? [left, right, "left", "right"] : [right, left, "right", "left"];
    const shown = [...new Map([...major].reverse().map((s) => [s.documentId, s])).values()]
      .reverse()
      .slice(0, 3);
    const where = [
      ...new Set(minor.map((s) => `the ${s.documentTitle} (${dayMonthYear(s.documentDate)})`)),
    ];
    return [
      {
        id: `r-side-carotid-${percent}`,
        method: "rule",
        summary: `The ${percent}% carotid stenosis is on the ${majorSide} in ${major.length} passages but on the ${minorSide} in ${where.join(" and ")}.`,
        passages: [...minor, ...shown],
      },
    ];
  });
}

/** Contradictions found by arithmetic and fixed checks, without a model. */
export function ruleContradictions(record: PatientRecord): Contradiction[] {
  return [...bmiChecks(record, measurements(record)), ...carotidSideChecks(record)];
}

const TOPIC: Record<string, RegExp> = {
  "r-bmi": /\bBMI\b/i,
  "r-side": /carotid|carotis|karotis|stenosis/i,
};

/** The rule checks, then the model's findings that do not restate one of them. */
export function mergeContradictions(
  rules: readonly Contradiction[],
  found: readonly Contradiction[],
): Contradiction[] {
  const restates = (c: Contradiction) =>
    rules.some((rule) => {
      const topic = Object.entries(TOPIC).find(([prefix]) => rule.id.startsWith(prefix))?.[1];
      const shared = c.passages.some((p) => rule.passages.some((r) => r.passageId === p.passageId));
      return shared && topic?.test(c.summary);
    });
  return [
    ...rules,
    ...found
      .filter((c) => !restates(c))
      .map((c, i) => ({ ...c, id: `m${i + 1}`, method: "model" as const })),
  ];
}
