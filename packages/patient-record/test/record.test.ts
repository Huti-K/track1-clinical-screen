import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPatientRecord } from "../src/index.js";

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
