import type { LetterBlock, LetterRow } from "@track1/shared";

/** A line of the letter once hard wraps are joined: its passages and whether a blank line precedes it. */
export type LetterLine = { text: string; spaced: boolean; ids: string[] };

type LineKind = Exclude<LetterBlock["kind"], "table">;

const HEADING = /^([^:]{2,60}):$/;
const ADDRESSEE = /^(?:Frau|Herrn?|Familie)\b/;
/** Place and date of the letter, such as `OrtXX, am 14.09.2020`. */
const PLACE_DATE = /^[^,]{1,40},\s*(?:am|den)\s+\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}$/i;
/** A short line of words that stands alone, such as `Radiologischer Befund` or `24h-RR-Messung`. */
const TITLE = /^[\p{L}\d][\p{L}\d ()/-]{1,58}$/u;
/** A heading without a colon over the lines below it, such as `Gesamtbeurteilung`. */
const SUBHEADING = /^\p{L}[\p{L} -]{2,38}$/u;
const CLOSING = /^mit (?:freundlichen|kollegialen|besten) grüßen\b/iu;
/** The column heads of a medication table: morning, midday, evening and night. */
const SCHEDULE = /\bmo mi ab na\b/i;
const DOSE = String.raw`[\d½¼¾]+(?:[,/]\d+)?`;
/** Drug, route, the four doses and the unit, such as `Ramipril 5mg oral 1 0 1/2 0 ST`. */
const ROW = new RegExp(String.raw`^(.+?) (\S+) (${DOSE}) (${DOSE}) (${DOSE}) (${DOSE})(?: (.+))?$`);
/** A drug on another schedule, such as `Methotrexat 10mg oral 1x/Woche 1 Tabl.`. */
const OTHER_ROW = /^(.+?) (oral|p\.o\.|s\.c\.|i\.v\.|i\.m\.) (.+)$/i;

/** A heading line such as `Entlassungsmedikation:` names the section of the lines below it. */
export function headingOf(line: string): string | undefined {
  const match = HEADING.exec(line);
  return match?.[1]?.trim();
}

/** A row's cells under the table's heads; a row on another schedule ends in one cell for the rest. */
function rowCells(text: string): string[] | undefined {
  const row = ROW.exec(text);
  if (row) return [...row.slice(1, 7), row[7] ?? ""];
  return OTHER_ROW.exec(text)?.slice(1, 4);
}

/**
 * How the letter sets its lines on the page, read from its line breaks and blank lines. The
 * blocks hold every passage once, in order. After the closing come the signer's lines; a title
 * after them starts an enclosure, such as the lab report, on a new page.
 */
export function layoutLetter(lines: LetterLine[]): LetterBlock[] {
  const blocks: LetterBlock[] = [];
  let titled = false;
  let closing: "open" | "closed" | "signed" = "open";
  /** Text and signer lines run on in one block until a blank line; other kinds stand alone. */
  const add = (kind: LineKind, line: LetterLine, newPage = false) => {
    const last = blocks.at(-1);
    const runsOn = kind === "text" || kind === "signature";
    if (runsOn && last && last.kind === kind && !line.spaced) last.lines.push(line.ids);
    else
      blocks.push({
        kind,
        spaced: line.spaced,
        lines: [line.ids],
        ...(newPage ? { newPage } : {}),
      });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as LetterLine;
    const starts = i === 0 || line.spaced;
    const alone = lines[i + 1]?.spaced ?? true;
    let end = i + 1;
    while (end < lines.length && !lines[end]?.spaced) end++;

    const [head] = line.ids;
    if (SCHEDULE.test(line.text) && head && line.ids.length === 1) {
      const rows: LetterRow[] = [];
      for (const row of lines.slice(i + 1, end)) {
        const cells = rowCells(row.text);
        const [passageId] = row.ids;
        if (!cells || !passageId || row.ids.length > 1) break;
        rows.push({ passageId, cells });
      }
      if (rows.length > 0) {
        const cells = ["", ...line.text.split(" ")];
        blocks.push({ kind: "table", spaced: line.spaced, head: { passageId: head, cells }, rows });
        i += rows.length;
        continue;
      }
    }

    const group = lines.slice(i, end);
    if (
      starts &&
      ADDRESSEE.test(line.text) &&
      group.length >= 2 &&
      group.length <= 6 &&
      group.every((l) => l.text.length <= 50)
    ) {
      blocks.push({ kind: "address", spaced: line.spaced, lines: group.map((l) => l.ids) });
      i = end - 1;
      continue;
    }

    if (PLACE_DATE.test(line.text)) add("date", line);
    else if (CLOSING.test(line.text)) {
      add("closing", line);
      closing = "closed";
    } else if (closing === "signed" && starts && alone && TITLE.test(line.text)) {
      add("title", line, true);
      closing = "open";
      titled = true;
    } else if (closing !== "open") {
      add("signature", line);
      closing = "signed";
    } else if (!titled && starts && alone && TITLE.test(line.text)) {
      add("title", line);
      titled = true;
    } else if (HEADING.test(line.text) || (starts && !alone && SUBHEADING.test(line.text))) {
      add("heading", line);
      titled = true;
    } else add("text", line);
  }
  return blocks;
}
