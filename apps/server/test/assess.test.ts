import type { Contradiction, Need, Source } from "@track1/shared";
import { describe, expect, it } from "vitest";
import { assess } from "../src/agent/assess.js";

const AS_OF = "2020-04-15";

function source(passageId: string, documentDate: string): Source {
  return { passageId, documentId: "D", documentTitle: "Brief", documentDate, quote: "q" };
}

function documented(...facts: { label: string; sources: Source[] }[]): Need {
  return {
    title: "Need",
    status: "documented",
    facts: facts.map((f) => ({ ...f, value: "v" })),
  };
}

describe("assess", () => {
  it("is red when the task needs something no document has", () => {
    const [need] = assess(
      [{ title: "Kidney function", status: "not_documented", facts: [], note: "No creatinine." }],
      [],
      AS_OF,
    );
    expect(need).toMatchObject({ light: "red", reason: "No creatinine." });
  });

  it("is green for a fact documented within six months", () => {
    const [need] = assess(
      [documented({ label: "Aspirin", sources: [source("a", "2020-04-15")] })],
      [],
      AS_OF,
    );
    expect(need?.light).toBe("green");
    expect(need?.facts[0]?.light).toBe("green");
  });

  it("is yellow for a value last documented ten months earlier, saying so", () => {
    const [need] = assess(
      [documented({ label: "EF", sources: [source("e", "2019-06-28")] })],
      [],
      AS_OF,
    );
    expect(need?.facts[0]).toMatchObject({
      light: "yellow",
      reason: "Last documented Jun 2019, 9 months before the latest document.",
    });
  });

  it("judges a trend by its newest source", () => {
    const [need] = assess(
      [
        documented({
          label: "Weight",
          sources: [source("w1", "2019-06-28"), source("w2", "2020-04-15")],
        }),
      ],
      [],
      AS_OF,
    );
    expect(need?.light).toBe("green");
  });

  it("is yellow when a cited passage is part of a contradiction, and the need takes its worst fact", () => {
    const bmi: Contradiction = {
      id: "c1",
      summary: "BMI 33.5 does not match 84 kg at 165 cm.",
      passages: [source("bmi", "2020-04-15"), source("kg", "2020-04-15")],
    };
    const [need] = assess(
      [
        documented(
          { label: "Height", sources: [source("cm", "2020-04-15")] },
          { label: "BMI", sources: [source("bmi", "2020-04-15")] },
        ),
      ],
      [bmi],
      AS_OF,
    );
    expect(need?.facts.map((f) => f.light)).toEqual(["green", "yellow"]);
    expect(need?.facts[1]?.reason).toBe("Contradiction: BMI 33.5 does not match 84 kg at 165 cm.");
    expect(need).toMatchObject({ light: "yellow", reason: "1 of 2 to check." });
  });
});
