import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentInfo, Passage, PatientDocument, PatientSummary } from "@track1/shared";
import { splitLetter } from "./passages.js";

export { decodeEntities, passageSays, splitLetter, splitPassages } from "./passages.js";

export type PatientRecord = {
  summary: PatientSummary;
  /** Oldest first. */
  documents: PatientDocument[];
  passage(id: string): Passage | undefined;
  document(id: string): PatientDocument | undefined;
};

type PatientFile = { id: string; name: string; sex: string; dateOfBirth: string };
/** `admission` also carries dates, which the letters can contradict; only its ID and type are kept. */
type DocumentsFile = {
  documents: (Omit<DocumentInfo, "stay"> & { admission?: { id: string; type: string } })[];
};
type DocumentFile = { text: string };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  return existsSync(path) ? readJson<T>(path) : undefined;
}

function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/**
 * Reads one patient folder in the hackathon's layout: `patient.json`, `documents.json`,
 * `documents/<id>.json`, and optionally `situations.json`, a list of example situations.
 */
export async function loadPatientRecord(directory: string): Promise<PatientRecord> {
  const patient = await readJson<PatientFile>(join(directory, "patient.json"));
  const listed = await readJson<DocumentsFile>(join(directory, "documents.json"));
  const situations = await readOptionalJson<string[]>(join(directory, "situations.json"));
  const infos: DocumentInfo[] = listed.documents
    .map(({ id, title, date, type, department, hospital, admission }) => ({
      id,
      title,
      date,
      type,
      department,
      ...(hospital ? { hospital } : {}),
      ...(admission ? { stay: { id: admission.id, type: admission.type } } : {}),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const documents = await Promise.all(
    infos.map(async (info) => {
      const file = await readJson<DocumentFile>(join(directory, "documents", `${info.id}.json`));
      return { ...info, ...splitLetter(info.id, file.text) };
    }),
  );
  const asOf = infos.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const passages = new Map(documents.flatMap((doc) => doc.passages.map((p) => [p.id, p])));
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return {
    summary: {
      id: patient.id,
      name: patient.name,
      sex: patient.sex,
      dateOfBirth: patient.dateOfBirth,
      asOf,
      ageAsOf: yearsBetween(patient.dateOfBirth, asOf),
      documents: infos,
      ...(situations?.length ? { situations } : {}),
    },
    documents,
    passage: (id) => passages.get(id),
    document: (id) => byId.get(id),
  };
}

/**
 * Reads every patient folder in `directory`, each subfolder with a `patient.json`, ordered by
 * patient ID. Two folders of one patient are refused: their screens and stores would mix.
 */
export async function loadPatientRecords(directory: string): Promise<PatientRecord[]> {
  const folders = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "patient.json")),
    )
    .map((entry) => join(directory, entry.name));
  const records = await Promise.all(folders.map((folder) => loadPatientRecord(folder)));
  records.sort((a, b) => a.summary.id.localeCompare(b.summary.id));
  records.forEach(({ summary }, i) => {
    if (records[i - 1]?.summary.id === summary.id)
      throw new Error(`Two folders in ${directory} hold patient ${summary.id}.`);
  });
  return records;
}
