import { describe, expect, it } from "vitest";
import { passageSays, splitLetter, splitPassages } from "../src/index.js";

// Shaped like the hackathon letters: <BR> line breaks, HTML entities, hard-wrapped prose, tables.
const LETTER = [
  "Allergien:",
  "Penicillin-Allergie (Exanthem, Juckreiz)",
  "",
  "Anamnese:",
  "Wegen zunehmender Atemnot seit drei Tagen",
  "wurde der Patient bei einer SpO2 von 88 % unter Raumluft vom Hausarzt zugewiesen und",
  "mit dem Verdacht auf eine Pneumonie stationär aufgenommen.",
  "Pleuraerguss: re &gt; li.",
  "",
  "Entlassungsmedikation:",
  "Applikation mo mi ab na Einheit Info",
  "Pantoloc 40mg oral 1 0 0 0 ST",
  "Ramipril 5mg oral 1 0 1 0 ST",
].join("<BR>");

describe("splitPassages", () => {
  const passages = splitPassages("123", LETTER);
  const texts = passages.map((p) => p.text);

  it("makes every medication table row its own passage under its heading", () => {
    const rows = passages.filter((p) => p.section === "Entlassungsmedikation");
    expect(rows.map((p) => p.text)).toEqual([
      "Entlassungsmedikation:",
      "Applikation mo mi ab na Einheit Info",
      "Pantoloc 40mg oral 1 0 0 0 ST",
      "Ramipril 5mg oral 1 0 1 0 ST",
    ]);
  });

  it("joins a hard-wrapped sentence into one passage", () => {
    expect(texts).toContain(
      "Wegen zunehmender Atemnot seit drei Tagen wurde der Patient bei einer SpO2 von 88 % unter Raumluft vom Hausarzt zugewiesen und mit dem Verdacht auf eine Pneumonie stationär aufgenommen.",
    );
  });

  it("decodes entities and numbers passages by document", () => {
    expect(texts).toContain("Pleuraerguss: re > li.");
    expect(passages[0]?.id).toBe("123-1");
    expect(new Set(passages.map((p) => p.id)).size).toBe(passages.length);
  });

  it("splits long prose after full sentences but not after abbreviations", () => {
    const prose =
      "Diagnose: Tiefe Beinvenenthrombose li. Unterschenkel mit Verschluss der V. poplitea sin., Ödem bds. Die Beschwerden waren bei Aufnahme bereits rückläufig. Im Aufnahmestatus fanden sich keine Zeichen einer Lungenembolie.";
    expect(splitPassages("9", prose).map((p) => p.text)).toEqual([
      "Diagnose: Tiefe Beinvenenthrombose li. Unterschenkel mit Verschluss der V. poplitea sin., Ödem bds. Die Beschwerden waren bei Aufnahme bereits rückläufig.",
      "Im Aufnahmestatus fanden sich keine Zeichen einer Lungenembolie.",
    ]);
  });
});

describe("splitLetter", () => {
  it("sets a discharge letter out as it prints, the lab enclosure after the signature on a new page", () => {
    const letter = [
      "ORTXXX, am 03.02.2021",
      "",
      "Frau",
      "Beispielpatientin",
      "Straße XY/AB",
      "PLZ Ort",
      "",
      "Diagnosen:",
      "Chronische Herzinsuffizienz",
      "Diab. Mell. II",
      "",
      "Entlassungsmedikation:",
      "Applikation mo mi ab na Einheit Info",
      "Ramipril 5mg oral 1 0 1/2 0 ST",
      "Clexane Injektionslösung 40 mg s.c. 0 0 1 0 Dosen",
      "Methotrexat 10mg oral 1x/Woche 1 Tabl.",
      "Mit freundlichen Grüßen",
      "",
      " OA XYZ Prim. Dr. X.",
      "",
      "Laborbefund",
      "",
      "NN_9999-0001 VN_9999-0001 | geb. 01.02.1960",
    ].join("<BR>");

    expect(splitLetter("7", letter).layout).toEqual([
      { kind: "date", spaced: false, lines: [["7-1"]] },
      { kind: "address", spaced: true, lines: [["7-2"], ["7-3"], ["7-4"], ["7-5"]] },
      { kind: "heading", spaced: true, lines: [["7-6"]] },
      { kind: "text", spaced: false, lines: [["7-7"], ["7-8"]] },
      { kind: "heading", spaced: true, lines: [["7-9"]] },
      {
        kind: "table",
        spaced: false,
        head: {
          passageId: "7-10",
          cells: ["", "Applikation", "mo", "mi", "ab", "na", "Einheit", "Info"],
        },
        rows: [
          { passageId: "7-11", cells: ["Ramipril 5mg", "oral", "1", "0", "1/2", "0", "ST"] },
          {
            passageId: "7-12",
            cells: ["Clexane Injektionslösung 40 mg", "s.c.", "0", "0", "1", "0", "Dosen"],
          },
          // A weekly drug has no four doses; the rest of its row stays one cell.
          { passageId: "7-13", cells: ["Methotrexat 10mg", "oral", "1x/Woche 1 Tabl."] },
        ],
      },
      { kind: "closing", spaced: false, lines: [["7-14"]] },
      { kind: "signature", spaced: true, lines: [["7-15"]] },
      { kind: "title", spaced: true, newPage: true, lines: [["7-16"]] },
      { kind: "text", spaced: true, lines: [["7-17"]] },
    ]);
  });

  it("tells a finding's title from a heading over lines, and keeps a long line's sentences on one line", () => {
    const finding = [
      "Frau",
      "Beispielpatientin",
      "",
      "OrtXX, am 14.09.2020",
      "",
      "Radiologischer Befund",
      "",
      "Gesamtbeurteilung",
      "Diagnose: Tiefe Beinvenenthrombose li. Unterschenkel mit Verschluss der V. poplitea sin., Ödem bds. Die Beschwerden waren bei Aufnahme bereits rückläufig. Im Aufnahmestatus fanden sich keine Zeichen einer Lungenembolie.",
      "",
      "Befund: Dr. Arzt",
    ].join("<BR>");

    expect(splitLetter("9", finding).layout).toEqual([
      { kind: "address", spaced: false, lines: [["9-1"], ["9-2"]] },
      { kind: "date", spaced: true, lines: [["9-3"]] },
      { kind: "title", spaced: true, lines: [["9-4"]] },
      { kind: "heading", spaced: true, lines: [["9-5"]] },
      { kind: "text", spaced: false, lines: [["9-6", "9-7"]] },
      { kind: "text", spaced: true, lines: [["9-8"]] },
    ]);
  });
});

describe("passageSays", () => {
  const row = "Ramipril 5mg oral 1 0 1/2 0 ST";

  it("accepts a quote that differs only in case and spacing", () => {
    expect(passageSays(row, "ramipril  5mg oral")).toBe(true);
  });

  it("accepts parts joined by an ellipsis when they appear in order", () => {
    expect(passageSays(row, "Ramipril 5mg … 1/2")).toBe(true);
    expect(passageSays(row, "1/2 … Ramipril")).toBe(false);
  });

  it("rejects words the passage does not contain", () => {
    expect(passageSays(row, "Ramipril 10mg")).toBe(false);
    expect(passageSays(row, "")).toBe(false);
  });
});
