import type { LetterBlock, Passage } from "@track1/shared";
import { headingOf, type LetterLine, layoutLetter } from "./layout.js";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** A line the letters hard-wrapped mid-sentence continues the previous one. */
function continues(previous: string, next: string, afterBlank: boolean): boolean {
  if (/[.!?]$/.test(previous)) return false;
  if (afterBlank) return /[a-zäöüß]$/i.test(previous) && /^[a-zäöüß]/.test(next);
  if (/^[a-zäöüß]/.test(next)) return true;
  // A value under its label ("RR bei Aufnahme:" / "140/90 mmHg"), but not a numbered finding.
  return /^\d/.test(next) && !/^\d+\)/.test(next);
}

/** Only long lines are prose worth splitting; short ones are list items such as `Diab. Mell. II`. */
const SENTENCE_SPLIT_FROM = 160;

/** Splits after a full stop that ends a word of four or more characters, so `li.` or `A.` never split. */
function sentences(line: string): string[] {
  if (line.length < SENTENCE_SPLIT_FROM) return [line];
  const parts: string[] = [];
  let start = 0;
  for (const match of line.matchAll(/(\S+?)[.!?]+\s+(?=[A-ZÄÖÜ])/g)) {
    if ((match[1] ?? "").length < 4) continue;
    const end = (match.index ?? 0) + match[0].length;
    parts.push(line.slice(start, end).trim());
    start = end;
  }
  parts.push(line.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * The document's passages and the layout that sets them on the page as the letter prints them.
 * The layout comes from the line breaks and blank lines the passages leave out.
 */
export function splitLetter(
  documentId: string,
  raw: string,
): { passages: Passage[]; layout: LetterBlock[] } {
  const lines = decodeEntities(raw)
    .split(/<br\s*\/?>/i)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const merged: { text: string; section: string; spaced: boolean }[] = [];
  let section = "";
  let blank = false;
  for (const line of lines) {
    if (!line) {
      blank = true;
      continue;
    }
    const previous = merged.at(-1);
    if (previous && continues(previous.text, line, blank)) previous.text += ` ${line}`;
    else {
      section = headingOf(line) ?? section;
      merged.push({ text: line, section, spaced: blank });
    }
    blank = false;
  }
  const passages: Passage[] = [];
  const laid: LetterLine[] = merged.map((line) => ({
    text: line.text,
    spaced: line.spaced,
    ids: sentences(line.text).map((text) => {
      const id = `${documentId}-${passages.length + 1}`;
      passages.push({ id, documentId, text, section: line.section });
      return id;
    }),
  }));
  return { passages, layout: layoutLetter(laid) };
}

/**
 * The document text as citable passages: one per sentence, list line or table row, in order. IDs
 * are `<documentId>-<n>` and stay stable as long as the text does.
 */
export function splitPassages(documentId: string, raw: string): Passage[] {
  return splitLetter(documentId, raw).passages;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[„“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the passage says `quote`: case and spacing may differ, and `...` may elide words between
 * parts that appear in order. Guards the screen against facts a passage does not contain.
 */
export function passageSays(passage: string, quote: string): boolean {
  const haystack = normalize(passage);
  const parts = quote
    .split(/\.{3}|…/)
    .map((part) => normalize(part).replace(/^[\s,;:.]+|[\s,;:.]+$/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return false;
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}
