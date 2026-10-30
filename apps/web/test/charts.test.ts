import { describe, expect, it } from "vitest";
import { referenceOf } from "../src/charts";

describe("referenceOf", () => {
  it.each([
    ["LV ejection fraction", "60 %", 60, "normal ≥ 50 %"],
    ["Heart function", "LVEF 55%", 55, "normal ≥ 50 %"],
    ["HbA1c", "6,4 %", 6.4, "target < 7 %"],
    ["Glycaemic control", "HbA1c 6.4 %", 6.4, "target < 7 %"],
  ])("places %s %s on its reference", (label, value, number, text) => {
    expect(referenceOf(label, value)).toMatchObject({ value: number, text });
  });

  it.each([
    ["LV ejection fraction", "55–60 %"],
    ["LV ejection fraction", "normal systolic function"],
    ["Carotid stenosis", "60 %"],
    ["HbA1c", "48 mmol/mol"],
  ])("draws no reference for %s %s", (label, value) => {
    expect(referenceOf(label, value)).toBeUndefined();
  });
});
