import type { AssessedFact, ScreenResponse } from "@track1/shared";
import { describe, expect, it } from "vitest";
import { type Layout, layoutScreen } from "../src/ScreenView";

const DISCHARGE = {
  documentId: "56780018",
  documentTitle: "Stat. Patientenbrief (Interne)",
  documentDate: "2021-02-03",
};

function fact(
  label: string,
  value: string,
  cited: [passageId: string, quote: string][],
  parts: Partial<AssessedFact> = {},
): AssessedFact {
  return {
    label,
    value,
    sources: cited.map(([passageId, quote]) => ({ passageId, quote, ...DISCHARGE })),
    light: "green",
    reason: "Documented Feb 2021.",
    ...parts,
  };
}

function drug(name: string, brand: string, dose: string, schedule: string, row: string) {
  return fact(name, `${name} ${dose}`, [[row, `${brand} ${dose}`]], {
    drug: { name, brand, dose, schedule, route: "oral" },
  });
}

function screen(
  needs: { title: string; facts: AssessedFact[] }[],
  medication: AssessedFact[] = [],
): ScreenResponse {
  return {
    id: "screen",
    patient: {
      id: "0000-0001",
      name: "Erika Testfrau",
      sex: "female",
      dateOfBirth: "1960-02-01",
      asOf: "2021-02-03",
      ageAsOf: 61,
      documents: [],
    },
    screen: {
      situation: "",
      role: "",
      task: "",
      needs: needs.map((need) => ({ ...need, status: "documented", light: "green", reason: "" })),
      leftOut: [],
      rejected: 0,
      model: "",
      elapsedMs: 0,
    },
    summary: { green: needs.length, yellow: 0, red: 0 },
    contradictions: [],
    trends: [],
    checks: [],
    basics: { measures: [], allergies: [], problems: [], medication },
    clarify: [],
    passages: {},
    cached: false,
  };
}

const section = (layout: Layout, title: string) =>
  layout.before.find((s) => s.title === title)?.lines.map((line) => [line.label, line.value]);

describe("layoutScreen", () => {
  it("puts only the allergy under Safety when the model files it with other conditions", () => {
    const layout = layoutScreen(
      screen([
        {
          title: "Other relevant conditions and allergy",
          facts: [
            fact("Heart failure", "Chronic heart failure", [
              ["56780018-11", "Chronische Herzinsuffizienz"],
            ]),
            fact(
              "Contrast media",
              "Contrast media",
              [["56780018-19", "KM-Allergie (Urtikaria, Atemnot)"]],
              { detail: "Hives, shortness of breath" },
            ),
          ],
        },
      ]),
    );

    expect(section(layout, "Safety")).toEqual([["Allergy", "Contrast media"]]);
    expect(section(layout, "Other relevant conditions and allergy")).toEqual([
      ["Heart failure", "Chronic heart failure"],
    ]);
  });

  it("names the blood thinner by its drug line, not by a finding that mentions the drug", () => {
    const layout = layoutScreen(
      screen([
        {
          title: "Prior similar episode",
          facts: [
            fact(
              "Clinical interpretation",
              "Attributed to atrial fibrillation",
              [["56780012-105", "auf ein intermittierendes Vorhofflimmern zurückgeführt"]],
              { detail: "Transient ischaemic attack; aspirin started." },
            ),
          ],
        },
        {
          title: "Current vascular medications",
          facts: [
            fact("Aspirin", "100 mg", [["56780018-52", "Thrombo ASS 100mg oral 1 0 0 0 ST"]], {
              detail: "Oral 1-0-0.",
              drug: {
                name: "Aspirin",
                brand: "Thrombo ASS",
                dose: "100 mg",
                schedule: "1-0-0",
                route: "oral",
              },
            }),
          ],
        },
      ]),
    );

    expect(section(layout, "Safety")).toEqual([["Blood thinner", "Aspirin 100 mg"]]);
    expect(section(layout, "Prior similar episode")).toEqual([
      ["Clinical interpretation", "Attributed to atrial fibrillation"],
    ]);
  });

  it("lists every drug of the latest medication table, the ones the screen picked first", () => {
    const metformin = drug("Metformin", "Glucophage", "1000 mg", "1-1-1", "56780018-53");
    const layout = layoutScreen(
      screen(
        [{ title: "Diabetes", facts: [metformin] }],
        [
          drug("Aspirin", "Thrombo ASS", "100 mg", "1-0-0", "56780018-52"),
          metformin,
          drug("Atorvastatin", "Sortis", "20 mg", "0-0-1", "56780018-56"),
        ],
      ),
    );

    expect(layout.drugs.map((line) => [line.drug?.name, line.drug?.dose])).toEqual([
      ["Metformin", "1000 mg"],
      ["Aspirin", "100 mg"],
      ["Atorvastatin", "20 mg"],
    ]);
  });

  it("marks the drugs to pause before surgery in the medication table, and lists only the rest under the check", () => {
    const metformin = drug("Metformin", "Glucophage", "1000 mg", "1-1-1", "56780018-53");
    const empagliflozin = drug("Empagliflozin", "Jardiance", "10 mg", "1-0-0", "56780018-60");
    const warfarin = drug("Warfarin", "Lawarin", "5 mg", "0-0-1", "56780012-102");
    const advice = {
      Metformin: "Royal Berkshire pre-op leaflet: may need reducing or pausing before surgery.",
      "SGLT2 inhibitor": "NHS sick-day rules: stop while dehydrated or not eating and drinking.",
      Anticoagulant: "Royal Berkshire pre-op leaflet: needs a dose plan.",
    };
    const result = screen([{ title: "Diabetes", facts: [metformin] }], [metformin, empagliflozin]);
    result.checks = [
      {
        kind: "surgery",
        title: "Review before surgery",
        rule: "Fixed list.",
        items: [
          { ...metformin, tag: "Metformin", detail: advice.Metformin },
          { ...empagliflozin, tag: "SGLT2 inhibitor", detail: advice["SGLT2 inhibitor"] },
          { ...warfarin, tag: "Anticoagulant", detail: advice.Anticoagulant },
        ],
        gaps: [],
        passages: ["56780018-53", "56780018-60", "56780012-102"],
      },
    ];

    const layout = layoutScreen(result);

    expect(layout.drugs.map((line) => [line.drug?.name, line.checks, line.advice])).toEqual([
      ["Metformin", ["surgery"], advice.Metformin],
      ["Empagliflozin", ["surgery"], advice["SGLT2 inhibitor"]],
    ]);
    expect(
      layout.before
        .find((s) => s.title === "Review before surgery")
        ?.lines.map((line) => [line.label, line.detail]),
    ).toEqual([["Anticoagulant", advice.Anticoagulant]]);
  });
  it("marks the sick-day drugs in the medication table without a section of their own", () => {
    const metformin = drug("Metformin", "Glucophage", "1000 mg", "1-1-1", "56780018-53");
    const sitagliptin = drug("Sitagliptin", "Januvia", "100 mg", "1-0-0", "56780018-54");
    const result = screen([{ title: "Diabetes", facts: [metformin] }], [metformin, sitagliptin]);
    result.checks = [
      {
        kind: "sickDay",
        title: "Sick-day rules",
        rule: "Fixed list.",
        items: [{ ...metformin, tag: "Metformin", detail: "Stop while dehydrated." }],
        gaps: [],
        passages: ["56780018-53"],
      },
    ];

    const layout = layoutScreen(result);

    expect(layout.drugs.map((line) => [line.drug?.name, line.checks])).toEqual([
      ["Metformin", ["sickDay"]],
      ["Sitagliptin", []],
    ]);
    expect(layout.before.map((s) => s.title)).not.toContain("Sick-day rules");
  });

  it("charts each measurement over time and rings the point a contradiction cites", () => {
    const point = (value: number, date: string, passageId: string) => ({
      value,
      display: `${value} kg/m²`,
      date,
      sources: [{ ...DISCHARGE, documentDate: date, passageId, quote: `BMI: ${value}` }],
    });
    const result = screen([]);
    result.trends = [
      {
        kind: "bmi",
        label: "BMI",
        unit: "kg/m²",
        points: [
          point(31.2, "2019-11-04", "56780012-20"),
          point(30, "2021-01-20", "56780016-14"),
          point(27.5, "2021-02-03", "56780018-25"),
        ],
        change: "−3.7 kg/m² since Nov 2019",
      },
    ];
    result.contradictions = [
      {
        id: "r-bmi-56780016",
        method: "rule",
        summary: "BMI 30 does not match 79 kg at 166 cm, which gives a BMI of 28.7.",
        passages: [{ ...DISCHARGE, passageId: "56780016-14", quote: "BMI: 30" }],
        relevant: true,
      },
    ];

    const trend = layoutScreen(result)
      .after.find((s) => s.title === "Over time")
      ?.lines.find((line) => line.label === "BMI")?.trend;

    expect(trend?.points.map((p) => [p.value, p.flagged])).toEqual([
      [31.2, false],
      [30, true],
      [27.5, false],
    ]);
    expect(trend?.change).toBe("−3.7 kg/m²");
  });
});
