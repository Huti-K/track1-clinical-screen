import { type PatientRecord, splitPassages } from "@track1/patient-record";
import { describe, expect, it } from "vitest";
import {
  bloodPressures,
  measurements,
  overviewTrends,
  ruleContradictions,
} from "../src/agent/measurements.js";

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

describe("overview measurements", () => {
  const r = record(
    [
      "A",
      "2020-03-02",
      "Mittelwert über 24 Stunden: 131/82 mmHg<BR>Tagesmittelwert: 147/90 mmHg<BR>Sinusrhythmus mit HF von 55 - 99 (73)/min;",
    ],
    [
      "B",
      "2020-03-20",
      "Wegen Blutdruckwerten von 192/104 mmHg erfolgte die Aufnahme.<BR>RR bei Aufnahme: 150/96 mmHg<BR>HF 78/min, Linkstyp<BR>Mitralklappe: unauffällig (DG max.:4mmHg).<BR>Abendliche RR-Spitzen bis 131/82 mmHg.",
    ],
    ["C", "2021-01-11", "RR: 136/82 mmHg<BR>HF: 64/min"],
  );

  it("reads every blood pressure a sentence about blood pressure gives, with its diastolic", () => {
    expect(bloodPressures(r).map((m) => [m.display, m.secondary, m.source.quote])).toEqual([
      ["131/82 mmHg", 82, "131/82 mmHg"],
      ["147/90 mmHg", 90, "147/90 mmHg"],
      ["192/104 mmHg", 104, "192/104 mmHg"],
      ["150/96 mmHg", 96, "150/96 mmHg"],
      ["131/82 mmHg", 82, "131/82 mmHg"],
      ["136/82 mmHg", 82, "136/82 mmHg"],
    ]);
  });

  it("merges a value a later letter restates, keeps two with the same systolic apart, and reads a single heart rate, not a range", () => {
    const vitals = overviewTrends(measurements(r), bloodPressures(r));
    const pressure = vitals.find((t) => t.kind === "bp");
    expect(pressure?.points.map((p) => [p.display, p.sources.map((s) => s.documentId)])).toEqual([
      ["131/82 mmHg", ["A", "B"]],
      ["147/90 mmHg", ["A"]],
      ["192/104 mmHg", ["B"]],
      ["150/96 mmHg", ["B"]],
      ["136/82 mmHg", ["C"]],
    ]);
    expect(vitals.find((t) => t.kind === "hr")?.points.map((p) => p.display)).toEqual([
      "78/min",
      "64/min",
    ]);
  });
});

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
    expect(
      found?.claims?.map((c) => [c.label, c.passages.map((p) => [p.documentId, p.term])]),
    ).toEqual([
      ["Right", [["B", "Rechts"]]],
      ["Left", [["A", "links"]]],
    ]);
  });

  it("does not compare stenoses of different degree", () => {
    const r = record(
      ["A", "2019-10-07", "Mittelgradige 70%ige Abgangsstenose der Arteria carotis interna links."],
      ["B", "2019-10-24", "Geringe 30%ige Stenose der A. carotis interna rechts."],
    );
    expect(sides(r)).toEqual([]);
  });
});
