/**
 * An approximate grader for the eval, never shown to the model. The case's own grading lives in
 * cases/rubric.ts, which stays out of the repository with the rest of cases/: each expected answer
 * becomes patterns that must all appear in the screen's text (titles, values and notes), and each
 * contradiction we know of becomes the passage that identifies it. Misses still need a human look:
 * a correct answer worded differently can fail a pattern.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Contradiction, ScreenResponse } from "@track1/shared";

type Check = RegExp[] | ((screen: ScreenResponse["screen"]) => boolean);

/** What cases/rubric.ts exports. */
export type Rubric = {
  /** The patient whose situations these are. */
  patient: string;
  /** Situations the prompts were never tuned on, graded like those in cases/situations.md. */
  heldout: { number: number; title: string; text: string }[];
  heldoutExpected: { id: string; question: string; answer: string }[];
  answers: Record<string, Check>;
  /** A contradiction found by reading the documents, by a passage only it cites. */
  known: { id: string; passage: string; summary?: RegExp }[];
};

export async function loadRubric(path: string): Promise<Rubric> {
  if (!existsSync(path))
    throw new Error(`${path} is missing: the cases stay out of the repository.`);
  return (await import(pathToFileURL(path).href)) as Rubric;
}

export function screenText(screen: ScreenResponse["screen"]): string {
  return screen.needs
    .flatMap((need) => [
      need.title,
      need.note ?? "",
      ...need.facts.flatMap((f) => [f.label, f.value, f.detail ?? ""]),
    ])
    .join("\n");
}

export function gradeAnswer(rubric: Rubric, id: string, screen: ScreenResponse["screen"]): boolean {
  const check = rubric.answers[id];
  if (!check) return false;
  if (typeof check === "function") return check(screen);
  const text = screenText(screen);
  return check.every((pattern) => pattern.test(text));
}

export function gradeContradictions(rubric: Rubric, found: readonly Contradiction[]) {
  const matches = (k: Rubric["known"][number], c: Contradiction) =>
    c.passages.some((p) => p.passageId === k.passage) && (!k.summary || k.summary.test(c.summary));
  const hit = new Set<string>();
  const unmatched: Contradiction[] = [];
  for (const c of found) {
    const known = rubric.known.filter((k) => matches(k, c));
    if (known.length === 0) unmatched.push(c);
    for (const k of known) hit.add(k.id);
  }
  return {
    known: [...hit],
    missed: rubric.known.map((k) => k.id).filter((id) => !hit.has(id)),
    unmatched,
  };
}
