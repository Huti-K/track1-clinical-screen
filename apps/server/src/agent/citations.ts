import { type Static, Type } from "@earendil-works/pi-ai";
import { type PatientRecord, passageSays } from "@track1/patient-record";
import type { Source } from "@track1/shared";

/** After this many rejected submissions a tool keeps what checks out and drops the rest. */
export const MAX_ATTEMPTS = 3;

export const Cited = Type.Object({
  passage: Type.String({ description: "Passage ID, such as 12340012-37." }),
  quote: Type.String({
    description:
      "The words in that passage that carry the fact, copied verbatim in the document's language.",
  }),
});
export type CitedArg = Static<typeof Cited>;

/** Each cited passage that exists and says its quote; a problem line for each that does not. */
export function verify(record: PatientRecord, cited: readonly CitedArg[], where: string) {
  const sources: Source[] = [];
  const problems: string[] = [];
  for (const { passage: id, quote } of cited) {
    const passage = record.passage(id.trim());
    const document = passage && record.document(passage.documentId);
    if (!passage || !document) problems.push(`${where}: passage ${id} does not exist.`);
    else if (!passageSays(passage.text, quote))
      problems.push(`${where}: "${quote}" is not in ${id}, which reads: "${passage.text}"`);
    else
      sources.push({
        passageId: passage.id,
        documentId: document.id,
        documentTitle: document.title,
        documentDate: document.date,
        quote: quote.trim(),
      });
  }
  return { sources, problems };
}

export function retryText(problems: string[]): string {
  return [
    "Nothing was saved. Fix these citations and call the tool again with the complete result:",
    ...problems.map((problem) => `- ${problem}`),
    "Quote only words that are in the cited passage, or cite the passage that says them.",
  ].join("\n");
}

/** Models sometimes send an array argument as a JSON string. */
export function parseArrays<T>(args: unknown, keys: readonly string[]): T {
  if (typeof args !== "object" || args === null) return args as T;
  const fixed: Record<string, unknown> = { ...args };
  for (const key of keys) {
    const value = fixed[key];
    if (typeof value !== "string") continue;
    try {
      fixed[key] = JSON.parse(value);
    } catch {
      // Left as is; validation reports it to the model.
    }
  }
  return fixed as T;
}
