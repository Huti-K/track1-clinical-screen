import type { AssessedFact, Contradiction, DocumentInfo, ScreenResponse } from "@track1/shared";

/** A hospital stay or visit with its documents, newest first. */
export type Stay = {
  key: string;
  /** "inpatient" or "outpatient"; none for a document that belongs to no stay. */
  type?: string;
  /** In English where the app knows the department, such as "Cardiology". */
  department: string;
  /** The months its documents span, such as "Apr 2020". */
  months: string;
  documents: DocumentInfo[];
  /** Whole months without a document between this stay and the next older one. */
  gapMonths: number;
};

const DEPARTMENTS: [RegExp, string][] = [
  [/kardiolog/i, "Cardiology"],
  [/onkolog/i, "Oncology"],
  [/radiolog/i, "Radiology"],
  [/patholog/i, "Pathology"],
  [/augen/i, "Ophthalmology"],
  [/chirurg/i, "Surgery"],
  [/gynäkolog|frauenheil/i, "Gynaecology"],
  [/neurolog/i, "Neurology"],
  [/an(a|ä)sthes/i, "Anaesthesia"],
  [/notfall|notaufnahme/i, "Emergency"],
  [/medizin|interne/i, "Internal medicine"],
];

const LETTER = /patientenbrief|arztbrief|entlassung/i;

/** "4. Medizinische Abteilung mit Kardiologie" reads as "Cardiology"; an unknown name stays German. */
export function departmentOf(name: string): string {
  return DEPARTMENTS.find(([pattern]) => pattern.test(name))?.[1] ?? name;
}

function monthOf(iso: string, year = true): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

function spanOf(first: string, last: string): string {
  if (first.slice(0, 7) === last.slice(0, 7)) return monthOf(last);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${monthOf(first, !sameYear)}–${monthOf(last)}`;
}

function monthsBetween(older: string, newer: string): number {
  const [oy, om, od] = older.split("-").map(Number) as [number, number, number];
  const [ny, nm, nd] = newer.split("-").map(Number) as [number, number, number];
  return (ny - oy) * 12 + nm - om - (nd < od ? 1 : 0);
}

/**
 * The documents grouped by their stay, newest stay first. A stay is named by the months of its
 * documents rather than by its admission dates, which the letters can contradict.
 */
export function staysOf(documents: DocumentInfo[]): Stay[] {
  const groups = new Map<string, DocumentInfo[]>();
  for (const doc of documents) {
    const key = doc.stay?.id ?? doc.id;
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }
  const stays = [...groups].map(([key, docs]): Stay => {
    const sorted = [...docs].sort(
      (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
    );
    const newest = sorted[0] as DocumentInfo;
    const oldest = sorted.at(-1) as DocumentInfo;
    const letter = sorted.find((d) => LETTER.test(`${d.title} ${d.type}`)) ?? newest;
    return {
      key,
      type: newest.stay?.type,
      department: departmentOf(letter.department),
      months: spanOf(oldest.date, newest.date),
      documents: sorted,
      gapMonths: 0,
    };
  });
  stays.sort((a, b) => (b.documents[0]?.date ?? "").localeCompare(a.documents[0]?.date ?? ""));
  stays.forEach((stay, i) => {
    const older = stays[i + 1]?.documents[0];
    const oldest = stay.documents.at(-1);
    if (older && oldest) stay.gapMonths = monthsBetween(older.date, oldest.date);
  });
  return stays;
}

/** Per document, the facts of this screen that cite it and the contradictions it is part of. */
export function citationsOf(screen: ScreenResponse | undefined) {
  const facts = new Map<string, AssessedFact[]>();
  const conflicts = new Map<string, Contradiction[]>();
  for (const need of screen?.screen.needs ?? [])
    for (const fact of need.facts)
      for (const id of new Set(fact.sources.map((s) => s.documentId)))
        facts.set(id, [...(facts.get(id) ?? []), fact]);
  for (const contradiction of screen?.contradictions ?? [])
    for (const id of new Set(contradiction.passages.map((p) => p.documentId)))
      conflicts.set(id, [...(conflicts.get(id) ?? []), contradiction]);
  return { facts, conflicts };
}
