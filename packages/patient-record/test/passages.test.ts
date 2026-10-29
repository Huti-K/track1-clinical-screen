import { describe, expect, it } from "vitest";
import { passageSays, splitPassages } from "../src/index.js";

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
