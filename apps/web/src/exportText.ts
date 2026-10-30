import type { Answer, Note, ScreenResponse, Source } from "@track1/shared";
import { formatDate } from "./components/ui";
import type { Layout, Line } from "./ScreenView";

const WHO = { patient: "Ask the patient", test: "Order or measure", records: "Check the records" };

/** The documents a line rests on, each once: "[Stat. Patientenbrief 03.02.2021]". */
function cite(sources: Source[]): string {
  const documents = [...new Map(sources.map((s) => [s.documentId, s])).values()];
  return documents.length
    ? ` [${documents.map((s) => `${s.documentTitle} ${formatDate(s.documentDate)}`).join("; ")}]`
    : "";
}

function lineText(line: Line): string {
  if (line.tone === "gap")
    return `- ${line.label}: not documented${line.detail ? ` (${line.detail})` : ""}${line.action ? ` → ${line.action}` : ""}`;
  const { drug } = line;
  const value = drug
    ? [drug.name, drug.dose, drug.schedule, drug.route].filter(Boolean).join(" ")
    : line.value;
  const label = value.toLowerCase().includes(line.label.toLowerCase()) ? "" : `${line.label}: `;
  const detail = line.detail && !drug ? `, ${line.detail}` : "";
  const flags = [
    line.tone === "absent" && "documented as absent",
    line.conflict && "contradicted",
    line.fact?.light === "yellow" && !line.conflict && line.fact.reason,
  ].filter(Boolean);
  const date = line.date ? ` (${formatDate(line.date)})` : "";
  return `- ${label}${value}${detail}${date}${flags.length ? ` – ${flags.join("; ")}` : ""}${cite(line.sources)}`;
}

/**
 * The screen as plain text for a note or a handover: the patient, the task, every section with
 * the documents each fact rests on, the open points, the questions asked and what was recorded.
 */
export function screenText({
  result,
  layout,
  asked,
  notes,
}: {
  result: ScreenResponse;
  layout: Layout;
  asked: { answer: Answer; lines: Line[] }[];
  notes: Note[];
}): string {
  const { patient, screen } = result;
  const section = (title: string, lines: string[]) => (lines.length ? ["", title, ...lines] : []);
  const basics = [
    ...layout.basics.measures.map((l) => `${l.label} ${l.value}`),
    ...layout.basics.allergies.map(
      (l) => `Allergy: ${l.label === "Allergy" ? l.value : `${l.label} (${l.value})`}`,
    ),
  ].concat(
    layout.basics.problems.length
      ? [`Known: ${layout.basics.problems.map((l) => l.label).join(", ")}`]
      : [],
  );
  return [
    `${patient.name}, ${patient.sex}, born ${formatDate(patient.dateOfBirth)}, ${patient.ageAsOf} y on ${formatDate(patient.asOf)}`,
    `${screen.role}: ${screen.task}${screen.occasion ? ` (${screen.occasion})` : ""}`,
    ...(basics.length ? [basics.join(" · ")] : []),
    ...layout.before.flatMap((s) => section(s.title, s.lines.map(lineText))),
    ...section("Medication", layout.drugs.map(lineText)),
    ...layout.after.flatMap((s) => section(s.title, s.lines.map(lineText))),
    ...section(
      "To clarify",
      (result.clarify ?? []).map((c) => {
        const answer = notes.filter((n) => n.clarifies === c.id).at(-1);
        return `- ${WHO[c.from]}: ${c.topic}: ${c.step} (${c.reason})${answer ? ` → answered: ${answer.text}` : ""}`;
      }),
    ),
    ...section(
      "Contradictions",
      result.contradictions
        .filter((c) => c.relevant)
        .map((c) => `- ${c.summary}${cite(c.passages)}`),
    ),
    ...section(
      "Asked",
      asked.flatMap(({ answer, lines }) => [
        `- ${answer.question}`,
        ...(lines.length
          ? lines.map((l) => `  ${lineText(l)}`)
          : ["  - No answer with a checked source"]),
      ]),
    ),
    ...section(
      "Recorded after the documents",
      notes.map(
        (n) =>
          `- ${n.topic}: ${n.text} (${n.source === "patient" ? "reported by the patient" : "clinician"}, ${formatDate(n.recordedAt.slice(0, 10))})`,
      ),
    ),
    "",
    `From ${patient.documents.length} documents up to ${formatDate(patient.asOf)}. Each fact names the documents it is quoted from.`,
  ].join("\n");
}
