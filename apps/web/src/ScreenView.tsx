import type {
  Answer,
  AssessedFact,
  CheckKind,
  Contradiction,
  Drug,
  Note,
  PatientSummary,
  ScreenResponse,
  Source,
} from "@track1/shared";
import {
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDashed,
  CircleSlash,
  ClipboardCopy,
  Clock,
  EyeOff,
  FileText,
  Info,
  MessageCircleQuestionMark,
  NotebookPen,
  ShieldAlert,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { ClarifyList, ClarifyPane, type NoteInput, noteTime } from "./Clarify";
import { RangeBar, referenceOf, Sparkline, type TrendChart } from "./charts";
import { Avatar, Button, cx, formatDate, Keys, Sex } from "./components/ui";
import type { DocumentTarget } from "./DocumentPanel";
import { screenText } from "./exportText";
import { cites, LIT, useCitesHovered } from "./hoverLinks";
import { Field, PANE, SHEET, SourceQuote } from "./Pane";
import { answersKey, DETAIL_WIDTH_KEY, useStored } from "./prefs";
import { RecordSearch } from "./RecordSearch";
import { ResizeHandle, usePaneDrag } from "./resize";

export const ROLES = [
  "Anaesthetist",
  "Surgeon",
  "General practitioner",
  "Emergency physician",
  "Oncologist",
  "Ward nurse",
];

const ALLERGY = /allerg|intoleran|unverträglich|\bcave\b/i;
const THINNER =
  /aspirin|\bass\b|clopidogrel|prasugrel|ticagrelor|heparin|enoxaparin|apixaban|rivaroxaban|edoxaban|dabigatran|warfarin|phenprocoumon|marcumar|anticoagul|antiplatelet|blood thinner/i;
/** A medication schedule as the screen writes it: morning-midday-evening, optionally night. */
const SCHEDULE = /\b([\d½¼]+)-([\d½¼]+)-([\d½¼]+)(?:-([\d½¼]+))?\b/;
const DOSE = /\d+(?:[.,]\d+)?\s?(?:mg|µg|mcg|g|ml|IU|IE|units?)\b(?:\s?s\.?c\.?)?/i;
/** A value that records an absence, such as "None known" or "Negative": documented, not missing. */
const ABSENT =
  /^(no|none|nil|negative|absent|without|keine?[nrms]?|ohne|not (present|detected)|ruled out|excluded)\b/i;

/** One line of the screen: a fact, a missing need, a trend or a check's item, as the list and the pane show it. */
export type Line = {
  key: string;
  /** The section it sits in; the pane names it above the value. */
  topic: string;
  label: string;
  value: string;
  detail?: string;
  /** For a gap: the one step that would close it. */
  action?: string;
  /** YYYY-MM-DD the line refers to. */
  date?: string;
  drug?: Drug;
  sources: Source[];
  /** `absent`: a document says it is not there. `note`: recorded after the documents. */
  tone: "allergy" | "gap" | "absent" | "note" | "plain";
  /** The assessed fact behind the line, for its light; trends, gaps and topics have none. */
  fact?: AssessedFact;
  conflict?: Contradiction;
  /** The fixed checks that list it, such as the drugs to review before surgery. */
  checks: CheckKind[];
  /** What the pre-op leaflet advises for a drug the surgery check lists from the same passage. */
  advice?: string;
  note?: Note;
  /** A topic the screen left out, which the pane offers to ask about. */
  leftOut?: boolean;
  /** For a measurement documented more than once, its points for the sparkline. */
  trend?: TrendChart;
};

type Section = { title: string; aside?: string; lines: Line[] };

/** A fact is a drug line when it has drug parts or carries a dose schedule. */
function isDrug(fact: AssessedFact): boolean {
  return (
    Boolean(fact.drug) ||
    SCHEDULE.test(fact.value) ||
    (DOSE.test(fact.value) && /weekly|week|daily/i.test(fact.value))
  );
}

/** The drug parts a fact gives, or what its value shows when the model gave none. */
function drugOf(fact: AssessedFact): Drug {
  if (fact.drug) return fact.drug;
  const schedule =
    fact.value.match(SCHEDULE)?.[0] ?? (/weekly|week/i.test(fact.value) ? "weekly" : "");
  const dose = fact.value.match(DOSE)?.[0] ?? "";
  return { name: fact.label, ...(dose ? { dose } : {}), ...(schedule ? { schedule } : {}) };
}

/** Words for what an allergy caused, as opposed to what caused it. */
const REACTION =
  /nausea|vomit|dizz|rash|urticaria|hives|itch|swelling|angioedema|anaphyla|shock|dyspn|bronchospasm|übelkeit|erbrechen|schwindel|exanthem/i;

/** An allergy line leads with the agent; the reaction it caused is the detail. */
function allergyLine(line: Line): Line {
  if (!REACTION.test(line.value)) return { ...line, label: "Allergy" };
  const agent = line.label
    .replace(/\s*\b(allergy|allergie|intolerance|reaction)\b\s*/gi, " ")
    .trim();
  return {
    ...line,
    label: "Allergy",
    value: agent || line.label,
    detail: [line.value, line.detail].filter(Boolean).join(", "),
  };
}

const newest = (sources: Source[]) =>
  sources
    .map((s) => s.documentDate)
    .sort()
    .at(-1);

/** Makes lines from a screen's facts; keys count up unless given, so the screen's own keep theirs. */
function lineFactory(result: ScreenResponse) {
  const checks = result.checks ?? [];
  const { contradictions } = result;
  const conflictOf = (sources: Source[]) =>
    contradictions.find((c) =>
      c.passages.some((p) => sources.some((s) => s.passageId === p.passageId)),
    );
  const checksOf = (sources: Source[]) =>
    checks.filter((c) => sources.some((s) => c.passages.includes(s.passageId))).map((c) => c.kind);
  const adviceOf = (sources: Source[]) =>
    checks
      .find((c) => c.kind === "surgery")
      ?.items.find((i) => i.sources.some((s) => sources.some((t) => t.passageId === s.passageId)))
      ?.detail;
  let count = 0;
  const key = () => `line-${count++}`;
  const line = (
    topic: string,
    fact: AssessedFact,
    tone: Line["tone"] = "plain",
    id = key(),
  ): Line => {
    const drug = isDrug(fact) ? drugOf(fact) : undefined;
    const detail =
      fact.detail ?? (drug ? [drug.schedule, drug.route].filter(Boolean).join(", ") : undefined);
    const advice = adviceOf(fact.sources);
    return {
      key: id,
      topic,
      label: fact.label,
      value: fact.value,
      ...(detail ? { detail } : {}),
      date: fact.date ?? newest(fact.sources),
      ...(drug ? { drug } : {}),
      sources: fact.sources,
      tone: ABSENT.test(fact.value) ? "absent" : tone,
      fact,
      conflict: conflictOf(fact.sources),
      checks: checksOf(fact.sources),
      ...(advice ? { advice } : {}),
    };
  };
  const gap = (topic: string, label: string, note?: string, action?: string, id = key()): Line => ({
    key: id,
    topic,
    label,
    value: "Not documented",
    ...(note ? { detail: note } : {}),
    ...(action ? { action } : {}),
    sources: [],
    tone: "gap",
    checks: [],
  });
  return { line, gap, conflictOf, key };
}

const isAllergy = (fact: AssessedFact) =>
  ALLERGY.test(`${fact.label} ${fact.value} ${fact.detail ?? ""}`) ||
  fact.sources.some((s) => ALLERGY.test(s.quote));

const allergyTone = (fact: AssessedFact): Line["tone"] => (isAllergy(fact) ? "allergy" : "plain");

/**
 * Where every line goes. Allergies and the blood thinner open the screen under Safety; a fixed
 * check lists what the screen does not show itself; each need is a section; drugs form the
 * medication table; missing needs and the measurements documented more than once follow.
 */
export function layoutScreen(result: ScreenResponse) {
  const { needs, leftOut = [] } = result.screen;
  const checks = result.checks ?? [];
  const { contradictions } = result;
  const { line, gap, conflictOf, key } = lineFactory(result);
  const basics = result.basics ?? { measures: [], allergies: [], problems: [], medication: [] };

  const documented = needs.filter((n) => n.status === "documented" && n.facts.length > 0);
  const items = documented.flatMap((need) => need.facts.map((fact) => ({ need, fact })));
  const named = (f: AssessedFact) => {
    const { name, brand = "" } = drugOf(f);
    return `${name} ${brand} ${f.value}`;
  };
  const allergies = items.filter((i) => isAllergy(i.fact));
  const thinner = items.find(
    (i) => !allergies.includes(i) && isDrug(i.fact) && THINNER.test(named(i.fact)),
  );
  const drugs = items.filter((i) => !allergies.includes(i) && i !== thinner && isDrug(i.fact));
  const used = new Set([...allergies, ...drugs, ...(thinner ? [thinner] : [])].map((i) => i.fact));
  const cited = new Set(items.flatMap((i) => i.fact.sources.map((s) => s.passageId)));
  const listed = basics.medication.filter((f) => !f.sources.some((s) => cited.has(s.passageId)));
  // What the screen shows elsewhere; a drug in the medication table carries the check as a chip.
  const onScreen = new Set(
    [...items.map((i) => i.fact), ...listed].flatMap((f) => f.sources.map((s) => s.passageId)),
  );

  const thinnerLine = thinner && line("Blood thinner", thinner.fact);
  const safety = [
    ...allergies.map((i) => allergyLine(line("Allergy", i.fact, "allergy"))),
    // The drug and its dose answer "which blood thinner"; the class is the label.
    ...(thinnerLine
      ? [
          {
            ...thinnerLine,
            label: "Blood thinner",
            value: thinnerLine.drug
              ? [thinnerLine.drug.name, thinnerLine.drug.dose].filter(Boolean).join(" ")
              : thinnerLine.value,
          },
        ]
      : []),
  ];
  const checked: Section[] = checks.map((check) => ({
    title: check.title,
    aside: check.rule,
    lines: [
      ...check.items
        .filter((item) => !item.sources.some((s) => onScreen.has(s.passageId)))
        .map((item) => ({
          ...line(check.title, item, item.tag === "Allergy" ? "allergy" : "plain"),
          label: item.tag,
        })),
      ...check.gaps.map((g) => gap(check.title, g.title, g.note, g.action)),
    ],
  }));
  const topics = documented.map((need) => ({
    title: need.title,
    lines: need.facts.filter((f) => !used.has(f)).map((f) => line(need.title, f)),
  }));
  const missing = needs
    .filter((n) => n.status === "not_documented")
    .map((n) => gap("Not documented", n.title, n.note, n.action));
  const trends: Line[] = (result.trends ?? []).map((t) => {
    const sources = t.points.flatMap((p) => p.sources);
    const last = t.points.at(-1);
    // The chart shows when; beside it the change alone, so a contradiction's badge still fits.
    const delta = Math.round(((last?.value ?? 0) - (t.points[0]?.value ?? 0)) * 10) / 10;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    return {
      key: key(),
      topic: "Over time",
      label: t.label,
      value: last?.display ?? "",
      detail: `${t.points.map((p) => p.display).join(" → ")} · ${t.change}, calculated`,
      ...(last ? { date: last.date } : {}),
      sources,
      tone: "plain",
      conflict: conflictOf(sources),
      checks: [],
      trend: {
        points: t.points.map((p) => ({ ...p, flagged: conflictOf(p.sources) !== undefined })),
        change: `${sign}${Math.abs(delta)} ${t.unit}`,
      },
    };
  });
  const nonEmpty = (sections: Section[]) => sections.filter((s) => s.lines.length > 0);

  return {
    before: nonEmpty([{ title: "Safety", lines: safety }, ...checked, ...topics]),
    drugs: [
      ...drugs.map((i) => line("Medication", i.fact)),
      ...listed.map((f) => line("Medication", f)),
    ],
    after: nonEmpty([
      { title: "Not documented", lines: missing },
      { title: "Over time", lines: trends },
    ]),
    leftOut: leftOut.map(
      (l): Line => ({
        key: key(),
        topic: "Not needed for this task",
        label: l.topic,
        value: l.topic,
        sources: l.sources.slice(0, 1),
        tone: "plain",
        checks: [],
        leftOut: true,
      }),
    ),
    basics: {
      measures: basics.measures.map((f, i) => line("Basics", f, "plain", `basic-measure-${i}`)),
      allergies: basics.allergies.map((f, i) => line("Basics", f, "allergy", `basic-allergy-${i}`)),
      problems: basics.problems.map((f, i) => line("Basics", f, "plain", `basic-problem-${i}`)),
    },
    relevant: contradictions.filter((c) => c.relevant),
  };
}

export type Layout = ReturnType<typeof layoutScreen>;

/** An answer's facts as lines under its question, and what no document answers as a gap. */
function answerLines(make: ReturnType<typeof lineFactory>, answer: Answer): Line[] {
  return [
    ...answer.facts.map((fact, i) =>
      make.line(answer.question, fact, allergyTone(fact), `answer-${answer.id}-${i}`),
    ),
    ...(answer.missing
      ? [
          make.gap(
            answer.question,
            answer.topic,
            answer.missing.note,
            answer.missing.action,
            `answer-${answer.id}-missing`,
          ),
        ]
      : []),
  ];
}

function noteLine(note: Note): Line {
  return {
    key: `note-${note.id}`,
    topic: "Recorded after the documents",
    label: note.topic,
    value: note.source === "patient" ? "Patient says" : "Clinician",
    detail: note.text,
    date: note.recordedAt.slice(0, 10),
    sources: [],
    tone: "note",
    checks: [],
    note,
  };
}

/** A date as a chart writes it: 2019-06-28 is 06/19. */
function monthYear(iso: string): string {
  const [year, month] = iso.split("-");
  return year && month ? `${month}/${year.slice(2)}` : iso;
}

const ROUTES: Record<string, string> = {
  oral: "p.o.",
  subcutaneous: "s.c.",
  intravenous: "i.v.",
  intramuscular: "i.m.",
};

/** The route as a chart abbreviates it, such as p.o. for oral. */
function route(text?: string): string {
  return text ? (ROUTES[text.toLowerCase()] ?? text) : "";
}

/** An old value's age from its reason, "Last documented Jun 2019, 9 months before the latest document." */
function monthsOld(line: Line): number | undefined {
  if (line.fact?.light !== "yellow" || line.conflict) return undefined;
  const months = line.fact.reason.match(/(\d+) months? before/)?.[1];
  return months ? Number(months) : undefined;
}

function LineIcon({ line }: { line: Line }) {
  if (line.tone === "allergy")
    return <ShieldAlert className="size-3.5 text-destructive" aria-label="Allergy" />;
  if (line.tone === "gap")
    return <CircleDashed className="size-3.5 text-muted-foreground" aria-label="Not documented" />;
  if (line.note)
    return line.note.source === "patient" ? (
      <UserRound className="size-3.5 text-accent-text" aria-label="Reported by the patient" />
    ) : (
      <NotebookPen className="size-3.5 text-accent-text" aria-label="Clinician's note" />
    );
  if (line.conflict)
    return <TriangleAlert className="size-3.5 text-warning" aria-label="In a contradiction" />;
  if (monthsOld(line) !== undefined)
    return <Clock className="size-3.5 text-warning" aria-label="Older than six months" />;
  if (line.tone === "absent")
    return (
      <CircleSlash className="size-3.5 text-muted-foreground" aria-label="Documented as absent" />
    );
  return null;
}

const CHIPS: Record<CheckKind, { text: string; title: string }> = {
  surgery: {
    text: "pre-op",
    title: "On the fixed list of drugs to reduce or pause before surgery",
  },
  contrast: { text: "contrast", title: "On the fixed checklist before contrast imaging" },
};

function Chips({ kinds, advice }: { kinds: CheckKind[]; advice?: string | undefined }) {
  return kinds.map((kind) => (
    <span
      key={kind}
      title={(kind === "surgery" && advice) || CHIPS[kind].title}
      className="ml-1.5 inline-block rounded-full bg-warning-wash px-1.5 py-px align-[1px] text-3xs font-medium text-warning"
    >
      {CHIPS[kind].text}
    </span>
  ));
}

/** Label, value, detail and date in fixed columns, so the values line up down the screen. */
function LineRow({
  line,
  selected,
  onSelect,
}: {
  line: Line;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const months = monthsOld(line);
  const gap = line.tone === "gap";
  const reference = gap || line.trend ? undefined : referenceOf(line.label, line.value);
  const lit = useCitesHovered(line.sources);
  return (
    <button
      type="button"
      onClick={() => onSelect(line.key)}
      aria-pressed={selected}
      title={[line.label, line.value, line.detail, line.action].filter(Boolean).join(" · ")}
      {...cites(line.sources)}
      className={cx(
        "grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)] items-baseline gap-x-2.5 rounded-lg px-2 py-[5px] text-left text-[13px] transition-colors duration-150 [&>span]:min-w-0 @xl/list:col-span-5 @xl/list:grid-cols-subgrid @xl/list:whitespace-nowrap @xl/list:[&>span:not(:first-child)]:truncate",
        selected ? "bg-accent-wash" : lit ? LIT : "hover:bg-surface-2",
      )}
    >
      <span className="translate-y-0.5 self-start">
        <LineIcon line={line} />
      </span>
      <span className="col-start-2 text-muted-foreground @xl/list:col-start-auto">
        {line.label}
      </span>
      <span
        className={cx(
          "col-start-2 tabular-nums @xl/list:col-start-auto",
          gap ? "text-muted-foreground" : "font-semibold",
          line.tone === "allergy" && "text-destructive",
          line.tone === "note" && "text-accent-text",
        )}
      >
        {gap ? "n.d." : line.value}
      </span>
      <span className="col-start-2 text-muted-foreground @xl/list:col-start-auto">
        {gap ? (
          <>
            {line.detail}
            {line.detail && line.action ? " · " : ""}
            <span className="text-accent-text">{line.action}</span>
          </>
        ) : line.trend ? (
          <>
            <Sparkline chart={line.trend} />
            {line.trend.change}
          </>
        ) : (
          <>
            {reference && <RangeBar reference={reference} />}
            {line.detail ?? reference?.text}
          </>
        )}
        <Chips kinds={line.checks} advice={line.advice} />
        {line.conflict && (
          <span
            title=""
            className="group/conflict relative ml-1.5 inline-flex cursor-help items-center gap-1 rounded-full bg-warning px-1.5 py-px align-[1px] text-3xs font-semibold text-surface uppercase tracking-wide"
          >
            <TriangleAlert className="size-3" aria-hidden />
            Contradiction
            <span
              role="tooltip"
              className="invisible absolute right-0 bottom-full z-30 mb-1.5 w-max max-w-80 rounded-lg bg-surface px-2.5 py-2 text-left text-xs font-normal tracking-normal text-foreground normal-case opacity-0 shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border transition-opacity duration-150 group-hover/conflict:visible group-hover/conflict:opacity-100"
            >
              <span className="block">{line.conflict.summary}</span>
              <span className="mt-1 block text-muted-foreground">
                {line.conflict.method === "rule" ? "Calculated check · " : ""}Open the line to
                compare the passages
              </span>
            </span>
          </span>
        )}
      </span>
      <span
        className={cx(
          "col-start-2 text-xs tabular-nums @xl/list:col-start-auto @xl/list:text-right",
          months === undefined ? "text-muted-foreground" : "text-warning",
        )}
      >
        {line.date ? monthYear(line.date) : ""}
        {months !== undefined && ` · ${months} mo`}
      </span>
    </button>
  );
}

/** A section's name sits in the margin beside its lines, as on a chart. */
function Margin({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-2 pt-2 shadow-[inset_0_1px_0_var(--border)] first:mt-0 first:pt-0 first:shadow-none @xl/list:col-span-5 @xl/list:grid @xl/list:grid-cols-subgrid">
      <h2
        className="truncate px-2 pt-1 pb-0.5 text-xs font-semibold text-muted-foreground @xl/list:col-span-5"
        title={aside ? `${title} · ${aside}` : title}
      >
        {title}
      </h2>
      <div className="min-w-0 @xl/list:col-span-5 @xl/list:grid @xl/list:grid-cols-subgrid @xl/list:content-start">
        {children}
      </div>
    </section>
  );
}

function SectionView({
  section,
  selected,
  onSelect,
}: {
  section: Section;
  selected?: string;
  onSelect: (key: string) => void;
}) {
  return (
    <Margin title={section.title} aside={section.aside}>
      {section.lines.map((line) => (
        <LineRow key={line.key} line={line} selected={line.key === selected} onSelect={onSelect} />
      ))}
    </Margin>
  );
}

function Slots({ schedule }: { schedule?: string }) {
  const m = schedule?.match(SCHEDULE);
  if (!m) return <span className="text-xs text-muted-foreground">{schedule}</span>;
  const slots = [m[1] ?? "0", m[2] ?? "0", m[3] ?? "0", m[4] ?? "0"];
  return (
    <span className="flex gap-[3px]" role="img" aria-label={`Schedule ${slots.join("-")}`}>
      {slots.map((dose, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: four fixed times of day
          key={i}
          className={cx(
            "grid size-[18px] place-items-center rounded-[5px] text-[9.5px] font-semibold not-italic",
            dose === "0" ? "bg-surface-2 text-transparent" : "bg-accent-wash text-accent-text",
          )}
        >
          {dose}
        </i>
      ))}
    </span>
  );
}

function DrugRow({
  line,
  selected,
  onSelect,
}: {
  line: Line;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const drug = line.drug ?? { name: line.label };
  const lit = useCitesHovered(line.sources);
  return (
    <button
      type="button"
      onClick={() => onSelect(line.key)}
      aria-pressed={selected}
      title={[drug.brand, line.value, line.detail].filter(Boolean).join(" · ")}
      {...cites(line.sources)}
      className={cx(
        "grid w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2 py-[4px] text-left text-[13px] whitespace-nowrap transition-colors duration-150 @xl/list:col-span-5 @xl/list:grid-cols-subgrid",
        selected ? "bg-accent-wash" : lit ? LIT : "hover:bg-surface-2",
      )}
    >
      <span>
        {line.conflict && (
          <TriangleAlert className="size-3.5 text-warning" aria-label="In a contradiction" />
        )}
      </span>
      <span className="flex min-w-0 items-baseline font-semibold">
        <span className="truncate">{drug.name}</span>
        <span className="shrink-0">
          <Chips kinds={line.checks} advice={line.advice} />
        </span>
      </span>
      <span className="tabular-nums">{drug.dose}</span>
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Slots schedule={drug.schedule} />
        <span className="text-muted-foreground">{route(drug.route)}</span>
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {line.date ? monthYear(line.date) : ""}
      </span>
    </button>
  );
}

function MedicationTable({
  lines,
  selected,
  onSelect,
}: {
  lines: Line[];
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const dates = new Set(lines.map((l) => newest(l.sources)));
  const [date] = dates;
  return (
    <Margin title="Meds" aside={dates.size === 1 && date ? formatDate(date) : undefined}>
      {lines.map((line) => (
        <DrugRow key={line.key} line={line} selected={line.key === selected} onSelect={onSelect} />
      ))}
    </Margin>
  );
}

/** Where the selected line comes from: its parts, its state and every passage it cites. */
function LinePane({
  line,
  passages,
  total,
  onClose,
  onOpenLetter,
  onCompare,
  onAsk,
  onRemoveNote,
}: {
  line: Line;
  passages: ScreenResponse["passages"];
  /** How many documents the patient has, for what "not documented" covers. */
  total: number;
  onClose: () => void;
  onOpenLetter: (target: DocumentTarget) => void;
  onCompare: (c: Contradiction) => void;
  onAsk: (question: string) => void;
  onRemoveNote: (id: string) => void;
}) {
  const sources = line.sources.filter(
    (s, i, all) => all.findIndex((t) => t.passageId === s.passageId) === i,
  );
  const documents = new Set(sources.map((s) => s.documentId)).size;
  const months = monthsOld(line);
  const { drug, note } = line;
  const gap = line.tone === "gap";
  const title =
    gap || note ? line.label : drug ? [drug.name, drug.dose].filter(Boolean).join(" ") : line.value;
  return (
    <aside aria-label="Sources of the selected line" className={cx(PANE, SHEET)}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LineIcon line={line} />
        <span className="min-w-0 flex-1 truncate">
          {line.topic}
          {line.label !== title && line.label !== line.topic ? ` · ${line.label}` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
          className="-my-1.5 -mr-2"
        >
          <X className="size-4" />
        </Button>
      </p>
      <h3
        className={cx(
          "mt-1 text-[22px] leading-tight font-semibold tracking-tight",
          line.tone === "allergy" && "text-destructive",
        )}
      >
        {title}
      </h3>
      {note && <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap">{note.text}</p>}
      <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-[13px]">
        {note ? (
          <>
            <Field label="Source">
              {note.source === "patient" ? "Reported by the patient" : "A clinician's note"}
            </Field>
            <Field label="Recorded">
              <span className="tabular-nums">{noteTime(note)}</span>
            </Field>
            {note.author && <Field label="By">{note.author}</Field>}
            <Field label="Status">Not from any document</Field>
          </>
        ) : gap ? (
          <>
            <Field label="Status">Not in any of the {total} documents</Field>
            {line.detail && <Field label="Missing">{line.detail}</Field>}
            {line.action && (
              <Field label="Next">
                <span className="text-accent-text">{line.action}</span>
              </Field>
            )}
          </>
        ) : drug ? (
          <>
            {drug.brand && <Field label="Brand">{drug.brand}</Field>}
            {drug.schedule && (
              <Field label="Schedule">
                <Slots schedule={drug.schedule} />
                <span className="text-muted-foreground tabular-nums">
                  {[SCHEDULE.test(drug.schedule) ? drug.schedule : "", route(drug.route)]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </Field>
            )}
          </>
        ) : (
          line.detail && <Field label="Detail">{line.detail}</Field>
        )}
        {line.tone === "absent" && <Field label="Status">Documented as absent</Field>}
        {line.date && !note && (
          <Field label="Date">
            <span className={cx("tabular-nums", months !== undefined && "text-warning")}>
              {monthYear(line.date)}
              {months !== undefined && ` · ${months} months old`}
            </span>
          </Field>
        )}
        {documents > 1 && <Field label="Documents">{documents}, same value</Field>}
      </dl>
      {note && (
        <button
          type="button"
          onClick={() => onRemoveNote(note.id)}
          className="mt-3 cursor-pointer text-xs font-medium text-accent-text hover:underline"
        >
          Remove this note
        </button>
      )}
      {line.leftOut && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => onAsk(about(line.label))}
        >
          <MessageCircleQuestionMark className="size-3.5" aria-hidden />
          Ask about it
        </Button>
      )}
      {line.conflict && (
        <div className="mt-3 rounded-xl bg-warning-wash px-3 py-2 text-xs">
          <p className="leading-relaxed">
            <TriangleAlert className="mr-1 inline size-3.5 text-warning" aria-hidden />
            {line.conflict.summary}
          </p>
          <button
            type="button"
            onClick={() => line.conflict && onCompare(line.conflict)}
            className="mt-1 cursor-pointer font-medium text-accent-text hover:underline"
          >
            Compare
          </button>
        </div>
      )}
      {sources.length > 0 && (
        <h4 className="mt-5 mb-2 text-xs font-semibold text-muted-foreground">
          {sources.length === 1 ? "Source" : `${sources.length} sources`}
        </h4>
      )}
      <div className="flex flex-col gap-2">
        {sources.map((source) => (
          <SourceQuote
            key={source.passageId}
            source={source}
            passages={passages}
            onOpenLetter={onOpenLetter}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * With nothing selected, the pane lists what the screen leaves open, grouped by who can close it,
 * with the contradictions in its passages among them.
 */
function Overview({
  layout,
  clarify,
  notes,
  onSelect,
  onCompare,
}: {
  layout: Layout;
  clarify: ScreenResponse["clarify"];
  notes: Note[];
  onSelect: (id: string) => void;
  onCompare: (c: Contradiction) => void;
}) {
  const listed = new Set(clarify.map((c) => c.contradictionId));
  const relevant = layout.relevant.filter((c) => !listed.has(c.id));
  const item = (c: Contradiction) => (
    <div
      key={c.id}
      {...cites(c.passages)}
      className="grid grid-cols-[16px_1fr] gap-2.5 py-2 text-[13px] [&+&]:shadow-[inset_0_1px_0_var(--border)]"
    >
      <TriangleAlert className="mt-0.5 size-3.5 text-warning" aria-hidden />
      <span className="min-w-0">
        <span className="block leading-snug">{c.summary}</span>
        <button
          type="button"
          onClick={() => onCompare(c)}
          className="mt-0.5 cursor-pointer text-xs text-accent-text hover:underline"
        >
          Compare
        </button>
      </span>
    </div>
  );
  return (
    <aside aria-label="To clarify" className={PANE}>
      <ClarifyList items={clarify} notes={notes} onSelect={onSelect} />
      {relevant.length > 0 && (
        <>
          <h2 className="mt-6 pt-5 text-[13px] font-semibold tracking-tight shadow-[inset_0_1px_0_var(--border)]">
            Contradictions on this screen
          </h2>
          <div className="mt-1">{relevant.map(item)}</div>
        </>
      )}
    </aside>
  );
}

/** The question the pane and the ask suggestions put for a topic. */
const about = (topic: string) => `What do the documents say about ${topic}?`;

type Suggestion = { label: string; question: string };

/** Up to three questions from what the screen could not fill, skipping those already asked. */
function suggestionsOf(layout: Layout, answers: Answer[]): Suggestion[] {
  const asked = new Set(answers.map((a) => a.question));
  const topics = [
    ...[...layout.before, ...layout.after].flatMap((s) => s.lines).filter((l) => l.tone === "gap"),
    ...layout.leftOut,
  ].map((l) => l.label);
  return [...new Set(topics)]
    .map((topic) => ({ label: `${topic}?`, question: about(topic) }))
    .filter((s) => !asked.has(s.question))
    .slice(0, 3);
}

/**
 * A follow-up question to the record, floating over the foot of the list; the answer joins the
 * screen as cited lines. While the field is empty and focused, the screen's gaps are offered.
 */
function AskDock({
  suggestions,
  onAsk,
}: {
  suggestions: Suggestion[];
  onAsk: (question: string) => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const ready = text.trim().length >= 3;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    onAsk(text);
    setText("");
  }
  return (
    <div className="pointer-events-none sticky bottom-0 z-20 mt-10 flex flex-col items-center gap-2 @max-4xl:pb-4">
      {/* Down past the column's bottom padding, to the edge of the panel. */}
      <div
        aria-hidden
        className="absolute -inset-x-4 -top-12 -bottom-8 bg-[linear-gradient(transparent,var(--surface)_3rem)] sm:-inset-x-10 lg:-inset-x-14"
      />
      {focused && !text && suggestions.length > 0 && (
        <div className="ui-enter-up pointer-events-auto relative flex max-w-full flex-wrap justify-center gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.question}
              type="button"
              // Keep the field focused, so the chips stay put until the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAsk(s.question)}
              title={s.question}
              className="max-w-64 cursor-pointer truncate rounded-full bg-surface-2 px-2.5 py-[5px] text-xs transition-colors duration-150 hover:bg-hover"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={submit}
        className="pointer-events-auto relative flex w-full max-w-[560px] items-center gap-2.5 rounded-full bg-surface py-1.5 pr-1.5 pl-4 shadow-[0_8px_28px_rgb(0_0_0/0.10),0_2px_6px_rgb(0_0_0/0.05)] ring-1 ring-border transition-shadow duration-150 has-focus-visible:ring-2 has-focus-visible:ring-accent-text dark:shadow-[0_8px_28px_rgb(0_0_0/0.45)]"
      >
        <MessageCircleQuestionMark className="size-4 shrink-0 text-accent-text" aria-hidden />
        <input
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // The field takes the Escape, so a selected line stays open.
            e.preventDefault();
            e.currentTarget.blur();
          }}
          aria-label="Ask about the documents"
          placeholder="Ask the documents"
          className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
        />
        {focused && <Keys keys={["esc"]} />}
        <button
          type="submit"
          disabled={!ready}
          aria-label="Ask"
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-150",
            ready
              ? "cursor-pointer bg-accent text-accent-foreground"
              : "bg-surface-2 text-muted-foreground",
          )}
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </form>
    </div>
  );
}

type Asked = { answer: Answer; lines: Line[] };
type Asking = { question: string; error?: string };

/** The questions asked on this screen, newest first, each with its cited answer or its gap. */
function AskedSection({
  asked,
  asking,
  selected,
  onSelect,
  onRemove,
  onRetry,
  onDismiss,
}: {
  asked: Asked[];
  asking: Asking[];
  selected?: string;
  onSelect: (key: string) => void;
  onRemove: (id: string) => void;
  onRetry: (question: string) => void;
  onDismiss: (question: string) => void;
}) {
  if (asked.length === 0 && asking.length === 0) return null;
  const question = (text: string, action?: ReactNode) => (
    <div className="flex items-center gap-2 px-2 pt-[5px] text-xs text-muted-foreground @xl/list:col-span-5">
      <span className="min-w-0 flex-1 truncate italic" title={text}>
        “{text}”
      </span>
      {action}
    </div>
  );
  return (
    <Margin title="Asked">
      {asking.map((a) => (
        <div key={`asking-${a.question}`} className="pb-[5px] @xl/list:col-span-5">
          {question(a.question)}
          {a.error ? (
            <p className="flex flex-wrap items-center gap-x-2 px-2 text-xs text-destructive">
              {a.error}
              <button
                type="button"
                onClick={() => onRetry(a.question)}
                className="cursor-pointer text-accent-text hover:underline"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => onDismiss(a.question)}
                className="cursor-pointer text-muted-foreground hover:underline"
              >
                Dismiss
              </button>
            </p>
          ) : (
            <p className="px-2 text-xs text-shimmer">Reading the documents…</p>
          )}
        </div>
      ))}
      {asked.map(({ answer, lines }) => (
        <div
          key={answer.id}
          className="@xl/list:col-span-5 @xl/list:grid @xl/list:grid-cols-subgrid"
        >
          {question(
            answer.question,
            <button
              type="button"
              aria-label={`Remove the question “${answer.question}”`}
              title="Remove from this screen"
              onClick={() => onRemove(answer.id)}
              className="cursor-pointer rounded p-0.5 hover:bg-surface-2 hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>,
          )}
          {lines.map((line) => (
            <LineRow
              key={line.key}
              line={line}
              selected={line.key === selected}
              onSelect={onSelect}
            />
          ))}
          {lines.length === 0 && (
            <p className="px-2 py-[5px] text-xs text-muted-foreground @xl/list:col-span-5">
              No answer with a checked source. Rephrase the question, or search the documents.
            </p>
          )}
        </div>
      ))}
    </Margin>
  );
}

function BasicChip({
  line,
  selected,
  onSelect,
  children,
}: {
  line: Line;
  selected: boolean;
  onSelect: (key: string) => void;
  children: ReactNode;
}) {
  const lit = useCitesHovered(line.sources);
  return (
    <button
      type="button"
      onClick={() => onSelect(line.key)}
      aria-pressed={selected}
      title={[line.label, line.value, line.detail, line.date && monthYear(line.date)]
        .filter(Boolean)
        .join(" · ")}
      {...cites(line.sources)}
      className={cx(
        "-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 transition-colors duration-150",
        selected ? "bg-accent-wash" : lit ? LIT : "hover:bg-surface-2",
      )}
    >
      {children}
      {(line.conflict || monthsOld(line) !== undefined) && <LineIcon line={line} />}
    </button>
  );
}

/** What every screen shows about her, whatever the task: who she is, her body measures, allergies and known problems, a labelled column each. */
function PatientStrip({
  patient,
  basics,
  selected,
  onSelect,
}: {
  patient: PatientSummary;
  basics: Layout["basics"];
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const FEW = 7;
  const chip = (line: Line, content: ReactNode) => (
    <BasicChip key={line.key} line={line} selected={selected === line.key} onSelect={onSelect}>
      {content}
    </BasicChip>
  );
  const dot = <span className="px-1 text-muted-foreground">·</span>;
  const column = (label: string, value: ReactNode, detail?: ReactNode, danger = false) => (
    <div className="min-w-0 @3xl/strip:px-[18px] @3xl/strip:first:pl-0">
      <p className={cx("mb-[3px] text-2xs", danger ? "text-destructive" : "text-muted-foreground")}>
        {label}
      </p>
      <div className="flex flex-wrap items-center text-sm leading-5 font-medium">{value}</div>
      {detail && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );

  // Height and weight say what they are by their unit; BMI keeps its name, on the line below.
  const bmi = basics.measures.find((line) => line.label === "BMI");
  const body = basics.measures.filter((line) => line !== bmi);
  const measured = basics.measures
    .map((line) => line.date)
    .filter(Boolean)
    .sort()
    .at(-1);
  const allergic = basics.allergies.some((line) => line.tone !== "absent");
  const [allergy] = basics.allergies;
  const problems = all ? basics.problems : basics.problems.slice(0, FEW);
  return (
    <div className="mt-[22px] border-t border-border pt-3.5 @container/strip">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 tabular-nums @3xl/strip:grid-cols-[auto_auto_auto_minmax(0,1fr)] @3xl/strip:gap-x-0 @3xl/strip:divide-x @3xl/strip:divide-border">
        {column(
          "Patient",
          patient.name,
          <>
            <Sex sex={patient.sex} /> {patient.ageAsOf} y · born {formatDate(patient.dateOfBirth)}
          </>,
        )}
        {basics.measures.length > 0 &&
          column(
            "Body",
            body.length > 0
              ? body.map((line, i) => (
                  <Fragment key={line.key}>
                    {i > 0 && dot}
                    {chip(line, line.value)}
                  </Fragment>
                ))
              : bmi && chip(bmi, `BMI ${bmi.value}`),
            (body.length > 0 && bmi) || measured ? (
              <>
                {body.length > 0 && bmi && chip(bmi, `BMI ${bmi.value}`)}
                {body.length > 0 && bmi && measured && " · "}
                {measured && monthYear(measured)}
              </>
            ) : undefined,
          )}
        {allergy &&
          column(
            basics.allergies.length > 1 ? "Allergies" : "Allergy",
            basics.allergies.map((line, i) => (
              <Fragment key={line.key}>
                {i > 0 && dot}
                {chip(
                  line,
                  line.tone === "absent" ? (
                    line.value
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <ShieldAlert className="size-3.5" aria-hidden />
                      {line.label === "Allergy" ? line.value : line.label}
                    </span>
                  ),
                )}
              </Fragment>
            )),
            basics.allergies.length === 1 && allergy.detail?.trim(),
            allergic,
          )}
        {basics.problems.length > 0 &&
          column(
            "Problems",
            <span className="flex flex-wrap gap-x-2.5 text-[13px] font-normal">
              {problems.map((line) => chip(line, line.label))}
              {basics.problems.length > FEW && (
                <button
                  type="button"
                  onClick={() => setAll(!all)}
                  aria-expanded={all}
                  className="cursor-pointer text-accent-text hover:underline"
                >
                  {all ? "fewer" : `+${basics.problems.length - FEW}`}
                </button>
              )}
            </span>,
          )}
      </div>
    </div>
  );
}

/** What the marks on the lines mean, the three kinds of "not there" first, behind an info button. */
function Legend() {
  const marks: [ReactNode, string][] = [
    [<CircleDashed key="nd" className="size-3" aria-hidden />, "n.d.: in no document"],
    [<CircleSlash key="absent" className="size-3" aria-hidden />, "documented as absent"],
    [
      <Clock key="old" className="size-3 text-warning" aria-hidden />,
      "over 6 months before the latest document",
    ],
    [<TriangleAlert key="contra" className="size-3 text-warning" aria-hidden />, "contradicted"],
    [
      <UserRound key="after" className="size-3 text-accent-text" aria-hidden />,
      "recorded after the documents",
    ],
  ];
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="What the marks mean"
        aria-describedby="screen-legend"
        className="grid size-5 cursor-help place-items-center rounded-full hover:bg-hover hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        id="screen-legend"
        role="tooltip"
        className="invisible absolute bottom-full left-0 z-30 mb-1.5 grid w-max max-w-[calc(100vw-2rem)] grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 rounded-lg bg-surface px-2.5 py-2 opacity-0 shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {marks.map(([icon, text]) => (
          <Fragment key={text}>
            {icon}
            <span>{text}</span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}

/** The role chip doubles as the role switch: the same occasion, seen by another role. */
function RoleChip({ role, onRole }: { role: string; onRole: (role: string) => void }) {
  const current = ROLES.find((r) => r.toLowerCase() === role.toLowerCase());
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-accent-wash py-[3px] pr-2 pl-2.5 text-[13px] font-medium text-accent-text">
      {role}
      <ChevronDown className="size-3.5" aria-hidden />
      <select
        aria-label="See this patient as another role"
        value={current ?? ""}
        onChange={(e) => e.target.value && onRole(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {!current && <option value="">{role}</option>}
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The column beside the screen's lines, in pixels; it never takes more than half the screen. */
const DETAIL = { min: 280, initial: 360, max: 640, share: 0.5 };

export function ScreenView({
  result,
  layout,
  notes,
  besideOpen,
  onOpenLetter,
  onCompare,
  onRole,
  onAddNote,
  onRemoveNote,
}: {
  result: ScreenResponse;
  layout: Layout;
  /** What clinicians recorded after the documents, for every screen of the patient. */
  notes: Note[];
  /** Whether a document or a comparison is open beside the screen. */
  besideOpen: boolean;
  onOpenLetter: (target: DocumentTarget) => void;
  onCompare: (c: Contradiction) => void;
  onRole: (role: string) => void;
  onAddNote: (note: NoteInput) => Promise<void>;
  onRemoveNote: (id: string) => void;
}) {
  const { screen, patient } = result;
  const clarify = result.clarify ?? [];
  const [answers, setAnswers] = useStored<Answer[]>(answersKey(result.id), []);
  const [asking, setAsking] = useState<Asking[]>([]);
  const askedTop = useRef<HTMLDivElement>(null);
  const make = useMemo(() => lineFactory(result), [result]);
  const asked = answers.map((answer) => ({ answer, lines: answerLines(make, answer) }));
  const noted = notes.map(noteLine);
  const passages = Object.assign({}, result.passages ?? {}, ...answers.map((a) => a.passages));
  const [selected, setSelected] = useState<string>();
  const lines = [
    ...layout.before.flatMap((s) => s.lines),
    ...layout.drugs,
    ...layout.after.flatMap((s) => s.lines),
    ...layout.leftOut,
    ...Object.values(layout.basics).flat(),
    ...asked.flatMap((a) => a.lines),
    ...noted,
  ];
  const line = lines.find((l) => l.key === selected);
  const point = clarify.find((c) => `clarify:${c.id}` === selected);
  const select = (key: string) => setSelected((s) => (s === key ? undefined : key));
  const [safety, ...topics] =
    layout.before[0]?.title === "Safety" ? layout.before : [undefined, ...layout.before];
  const [copied, setCopied] = useState<"done" | "failed">();

  async function ask(text: string) {
    const question = text.trim();
    if (question.length < 3 || asking.some((a) => a.question === question && !a.error)) return;
    askedTop.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setAsking((list) => [{ question }, ...list.filter((a) => a.question !== question)]);
    try {
      const answer = await api.answer(patient.id, screen.situation, question);
      setAnswers((list) => [answer, ...list.filter((a) => a.id !== answer.id)]);
      setAsking((list) => list.filter((a) => a.question !== question));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setAsking((list) => list.map((a) => (a.question === question ? { ...a, error } : a)));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(screenText({ result, layout, asked, notes }));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(undefined), 1800);
  }
  const [detailWidth, setDetailWidth] = useStored(DETAIL_WIDTH_KEY, DETAIL.initial);
  const grid = useRef<HTMLDivElement>(null);
  const detailMax = () =>
    Math.max(DETAIL.min, Math.min(DETAIL.max, (grid.current?.clientWidth ?? 0) * DETAIL.share));
  const detail = usePaneDrag({
    measure: () => Math.min(detailWidth, detailMax()),
    min: DETAIL.min,
    max: detailMax,
    grows: "left",
    reset: () => DETAIL.initial,
    onDrag: (width) =>
      grid.current?.style.setProperty("--detail-width", `${width ?? detailWidth}px`),
    onCommit: setDetailWidth,
  });

  useEffect(() => {
    if (!selected) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setSelected(undefined);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [selected]);

  return (
    <div
      ref={grid}
      style={{ "--detail-width": `${detailWidth}px` } as CSSProperties}
      data-beside={besideOpen || undefined}
      className="group/screen flex flex-col @4xl:min-h-0 @4xl:flex-1 @4xl:flex-row"
    >
      <div className="min-w-0 flex-1 px-4 py-8 sm:px-10 lg:px-14 @4xl:overflow-y-auto @4xl:[scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[880px]">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] leading-snug font-semibold tracking-tight">
                {screen.task}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                <RoleChip role={screen.role} onRole={onRole} />
                {screen.occasion && (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                    {screen.occasion}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="size-3.5 shrink-0" aria-hidden />
                  {patient.documents.length} documents to {formatDate(patient.asOf)}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <RecordSearch documents={patient.documents} onOpen={onOpenLetter} />
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  copied === "done"
                    ? "Copied"
                    : copied === "failed"
                      ? "The browser did not allow copying"
                      : "Copy the screen as text"
                }
                onClick={copy}
              >
                {copied === "done" ? (
                  <Check className="size-3.5 text-success" />
                ) : copied === "failed" ? (
                  <X className="size-3.5 text-destructive" />
                ) : (
                  <ClipboardCopy className="size-3.5" />
                )}
              </Button>
            </div>
          </header>
          <PatientStrip
            patient={patient}
            basics={layout.basics}
            selected={selected}
            onSelect={select}
          />

          <div className="@container/list mt-6 min-w-0">
            {/* Where a new answer appears; asking scrolls it into view. */}
            <div ref={askedTop} className="scroll-mt-6" />
            <div className="@xl/list:grid @xl/list:grid-cols-[14px_fit-content(128px)_fit-content(176px)_minmax(0,1fr)_auto] @xl/list:gap-x-2.5">
              <AskedSection
                asked={asked}
                asking={asking}
                selected={selected}
                onSelect={select}
                onRemove={(id) => setAnswers((list) => list.filter((a) => a.id !== id))}
                onRetry={(question) => void ask(question)}
                onDismiss={(question) =>
                  setAsking((list) => list.filter((a) => a.question !== question))
                }
              />
              {safety && <SectionView section={safety} selected={selected} onSelect={select} />}
              {noted.length > 0 && (
                <SectionView
                  section={{ title: "Noted", lines: noted }}
                  selected={selected}
                  onSelect={select}
                />
              )}
              {topics.map(
                (section) =>
                  section && (
                    <SectionView
                      key={section.title}
                      section={section}
                      selected={selected}
                      onSelect={select}
                    />
                  ),
              )}
              {layout.drugs.length > 0 && (
                <MedicationTable lines={layout.drugs} selected={selected} onSelect={select} />
              )}
              {layout.after.map((section) => (
                <SectionView
                  key={section.title}
                  section={section}
                  selected={selected}
                  onSelect={select}
                />
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 text-xs text-muted-foreground">
              {layout.leftOut.length > 0 && (
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <EyeOff className="size-3.5" aria-hidden />
                  Not needed:
                  {layout.leftOut.map((topic, i) => (
                    <button
                      key={topic.key}
                      type="button"
                      onClick={() => select(topic.key)}
                      aria-pressed={topic.key === selected}
                      {...cites(topic.sources)}
                      className={cx(
                        "cursor-pointer hover:text-foreground hover:underline",
                        topic.key === selected && "text-foreground underline",
                      )}
                    >
                      {topic.label}
                      {i < layout.leftOut.length - 1 ? "," : ""}
                    </button>
                  ))}
                </p>
              )}
              {screen.rejected > 0 && (
                <p>
                  {screen.rejected} fact{screen.rejected === 1 ? "" : "s"} left out because no
                  passage says {screen.rejected === 1 ? "it" : "them"}.
                </p>
              )}
              <Legend />
            </div>
          </div>
          <AskDock
            suggestions={suggestionsOf(layout, answers)}
            onAsk={(question) => void ask(question)}
          />
        </div>
      </div>

      <ResizeHandle
        label="Resize the side column"
        drag={detail}
        value={detailWidth}
        min={DETAIL.min}
        max={DETAIL.max}
        className="-mx-[5px] hidden self-stretch @4xl:flex"
      />
      {point ? (
        <ClarifyPane
          key={point.id}
          item={point}
          notes={notes}
          passages={passages}
          contradiction={layout.relevant.find((c) => c.id === point.contradictionId)}
          onClose={() => setSelected(undefined)}
          onOpenLetter={onOpenLetter}
          onCompare={onCompare}
          onAddNote={onAddNote}
          onRemoveNote={onRemoveNote}
        />
      ) : line ? (
        <LinePane
          key={line.key}
          line={line}
          passages={passages}
          total={patient.documents.length}
          onClose={() => setSelected(undefined)}
          onOpenLetter={onOpenLetter}
          onCompare={onCompare}
          onAsk={(question) => {
            setSelected(undefined);
            void ask(question);
          }}
          onRemoveNote={(id) => {
            setSelected(undefined);
            onRemoveNote(id);
          }}
        />
      ) : (
        <Overview
          layout={layout}
          clarify={clarify}
          notes={notes}
          onSelect={(id) => select(`clarify:${id}`)}
          onCompare={onCompare}
        />
      )}
    </div>
  );
}

/** The patient above the scenario box, before a screen is built. */
export function PatientHeader({ patient }: { patient: ScreenResponse["patient"] }) {
  return (
    <div className="flex items-center gap-3.5">
      <Avatar name={patient.name} className="size-11 text-[15px]" />
      <div className="min-w-0">
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{patient.name}</h1>
        <p className="text-[13px] text-muted-foreground tabular-nums">
          <Sex sex={patient.sex} /> · born {formatDate(patient.dateOfBirth)} · {patient.ageAsOf} y
          on {formatDate(patient.asOf)} · {patient.documents.length} documents
        </p>
      </div>
    </div>
  );
}

export function ScreenSkeleton({ documents }: { documents: number }) {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <p className="text-sm text-shimmer">Reading {documents} documents for your task…</p>
      <div className="grid gap-8 @4xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="skeleton h-6 w-full" />
          ))}
        </div>
        <div className="skeleton h-56 rounded-2xl" />
      </div>
    </div>
  );
}
