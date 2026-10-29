import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentInfo, Passage, PatientDocument, PatientSummary } from "@track1/shared";
import { splitPassages } from "./passages.js";

export { decodeEntities, passageSays, splitPassages } from "./passages.js";

export type PatientRecord = {
  summary: PatientSummary;
  /** Oldest first. */
  documents: PatientDocument[];
  passage(id: string): Passage | undefined;
  document(id: string): PatientDocument | undefined;
};

type PatientFile = { id: string; name: string; sex: string; dateOfBirth: string };
type DocumentsFile = {
  documents: { id: string; title: string; date: string; type: string; department: string }[];
};
type DocumentFile = { text: string };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function yearsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

/** Reads one patient folder in the hackathon's layout: `patient.json`, `documents.json`, `documents/<id>.json`. */
export async function loadPatientRecord(directory: string): Promise<PatientRecord> {
  const patient = await readJson<PatientFile>(join(directory, "patient.json"));
  const listed = await readJson<DocumentsFile>(join(directory, "documents.json"));
  const infos: DocumentInfo[] = listed.documents
    .map(({ id, title, date, type, department }) => ({ id, title, date, type, department }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const documents = await Promise.all(
    infos.map(async (info) => {
      const file = await readJson<DocumentFile>(join(directory, "documents", `${info.id}.json`));
      return { ...info, passages: splitPassages(info.id, file.text) };
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
    },
    documents,
    passage: (id) => passages.get(id),
    document: (id) => byId.get(id),
  };
}
