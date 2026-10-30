import { type PatientRecord, splitPassages } from "@track1/patient-record";
import { describe, expect, it } from "vitest";
import { ruleContradictions } from "../src/agent/measurements.js";

/** A record of one-line documents, each `[id, date, text]`, with `<BR>` between passages. */
function record(...docs: [string, string, string][]): PatientRecord {
  const documents = docs.map(([id, date, text]) => ({
    id,
    date,
    title: `Brief ${id}`,
    type: "Arztbrief",
    department: "Interne",
    passages: splitPassages(id, text),
  }));
  const passages = new Map(documents.flatMap((d) => d.passages.map((p) => [p.id, p])));
  return {
    summary: {
      id: "p",
      name: "Test",
      sex: "female",
      dateOfBirth: "1960-02-01",
      asOf: "2021-02-03",
      ageAsOf: 61,
      documents,
    },
    documents,
    passage: (id) => passages.get(id),
    document: (id) => documents.find((d) => d.id === id),
  };
}

const sides = (r: PatientRecord) => ruleContradictions(r).filter((c) => c.id.startsWith("r-side"));

describe("carotid side check", () => {
  it("reads the artery's side, not the eye's, and raises no alarm when all agree", () => {
    const r = record(
      ["A", "2019-10-07", "Mittelgradige 70%ige Abgangsstenose der Arteria carotis interna links."],
      ["B", "2019-10-09", "Diagnose: TIA mit Sehstörung li. Auge bei 70% Stenose der A. Carotis sin."],
      [
        "C",
        "2019-10-09",
        "Indikation: Doppelbilder Auge re., Schwindel beim Aufstehen, 70% Karotisstenose links",
      ],
      [
        "D",
        "2019-10-07",
        "Links zeigt die A. carotis interna eine Einengung durch weiche Plaques mit verdickter Gefäßwand. zu etwa 70%. Auf der rechten Seite nur geringe Wandunregelmäßigkeiten ohne Stenose der Carotis.",
      ],
    );
    expect(sides(r)).toEqual([]);
  });

  it("flags the same stenosis put on the other side, linking both sides", () => {
    const r = record(
      ["A", "2019-10-07", "Mittelgradige 70%ige Abgangsstenose der Arteria carotis interna links."],
      [
        "B",
        "2019-10-24",
        "Rechts zeigt die A. carotis interna eine Einengung durch weiche Plaques zu etwa 70%.",
      ],
    );
    const [found] = sides(r);
    expect(found?.summary).toMatch(/70% carotid stenosis/);
    expect(found?.passages.map((p) => p.documentId).sort()).toEqual(["A", "B"]);
  });

  it("does not compare stenoses of different degree", () => {
    const r = record(
      ["A", "2019-10-07", "Mittelgradige 70%ige Abgangsstenose der Arteria carotis interna links."],
      ["B", "2019-10-24", "Geringe 30%ige Stenose der A. carotis interna rechts."],
    );
    expect(sides(r)).toEqual([]);
  });
});
