import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPatientRecord, loadPatientRecords } from "../src/index.js";

let folder: string | undefined;

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});

/** A patient folder in the hackathon's layout: one letter from a stay, one finding without one. */
async function patientFolder(): Promise<string> {
  folder = await mkdtemp(join(tmpdir(), "patient-"));
  await mkdir(join(folder, "documents"));
  const patient = {
    id: "0000-0001",
    name: "Erika Testfrau",
    sex: "female",
    dateOfBirth: "1960-02-01",
  };
  const documents = [
    {
      id: "D1",
      title: "Stat. Patientenbrief (Interne)",
      date: "2021-02-03",
      type: "Arztbrief(Inter.)",
      department: "3. Medizinische Abteilung mit Onkologie",
      admission: {
        id: "0000-0005",
        type: "inpatient",
        admission: { date: "2021-01-29", time: "09:15:00" },
        discharge: { date: "2021-02-03", time: "11:30:00" },
      },
    },
    {
      id: "D2",
      title: "Histologie-Befund",
      date: "2021-02-01",
      type: "HistoBefund",
      department: "Pathologisches Institut",
    },
  ];
  await writeFile(join(folder, "patient.json"), JSON.stringify(patient));
  await writeFile(join(folder, "documents.json"), JSON.stringify({ documents }));
  for (const { id } of documents)
    await writeFile(
      join(folder, "documents", `${id}.json`),
      JSON.stringify({ text: "Befund:<BR>Unauffällig." }),
    );
  return folder;
}

describe("loadPatientRecord", () => {
  it("keeps the stay a document belongs to, but not the admission dates the letters can contradict", async () => {
    const { summary } = await loadPatientRecord(await patientFolder());
    const stayOf = (id: string) => summary.documents.find((d) => d.id === id)?.stay;
    expect(stayOf("D1")).toEqual({ id: "0000-0005", type: "inpatient" });
    expect(stayOf("D2")).toBeUndefined();
  });
});

/** A folder `name` in `root` for patient `id` with one letter, and its examples when given. */
async function writePatient(root: string, name: string, id: string, situations?: string[]) {
  const directory = join(root, name);
  await mkdir(join(directory, "documents"), { recursive: true });
  const patient = { id, name: `Patient ${id}`, sex: "male", dateOfBirth: "1950-01-01" };
  const documents = [
    { id: `${id}-D1`, title: "Befund", date: "2020-01-01", type: "Befund", department: "Innere" },
  ];
  await writeFile(join(directory, "patient.json"), JSON.stringify(patient));
  await writeFile(join(directory, "documents.json"), JSON.stringify({ documents }));
  await writeFile(
    join(directory, "documents", `${id}-D1.json`),
    JSON.stringify({ text: "Befund:<BR>Unauffällig." }),
  );
  if (situations) await writeFile(join(directory, "situations.json"), JSON.stringify(situations));
}

describe("loadPatientRecords", () => {
  it("reads every patient folder in order of patient ID, each with its own letters and examples", async () => {
    folder = await mkdtemp(join(tmpdir(), "patients-"));
    await writePatient(folder, "a", "0000-0002", ["Pre-operative check before his hip operation."]);
    await writePatient(folder, "b", "0000-0001");
    // A folder without a patient.json is no patient.
    await mkdir(join(folder, "notes"));

    const records = await loadPatientRecords(folder);

    expect(
      records.map(({ summary }) => [
        summary.id,
        summary.documents.map((d) => d.id),
        summary.situations,
      ]),
    ).toEqual([
      ["0000-0001", ["0000-0001-D1"], undefined],
      ["0000-0002", ["0000-0002-D1"], ["Pre-operative check before his hip operation."]],
    ]);
  });

  it("refuses two folders that hold the same patient", async () => {
    folder = await mkdtemp(join(tmpdir(), "patients-"));
    await writePatient(folder, "a", "0000-0001");
    await writePatient(folder, "copy", "0000-0001");

    await expect(loadPatientRecords(folder)).rejects.toThrow("0000-0001");
  });
});
