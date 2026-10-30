import { describe, expect, it } from "vitest";
import { unreadable } from "../src/agent/answers.js";

describe("unreadable", () => {
  it.each([
    "What was the last HbA1c?",
    "Wie hoch war der Blutdruck zuletzt?",
    "CRP?",
    "eGFR",
    "T2DM since when",
    "Angstschweiß?",
    "Durchschnitt?",
    "KM-Allergie",
    "Herzschrittmacher",
  ])("reads %j as a question", (question) => {
    expect(unreadable(question)).toBe(false);
  });

  it.each([
    "asdf",
    "asdfasdf",
    "qwertz",
    "hjkl hjkl",
    "sdkfjhsdkf",
    "aslkdjfalskdjf",
    "asdasd",
    "jjjjjj",
    "!!!???",
    "123 456",
  ])("turns away %j", (question) => {
    expect(unreadable(question)).toBe(true);
  });
});
