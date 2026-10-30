import type { AssessedFact, AssessedNeed, Contradiction, Light, Need } from "@track1/shared";

/** A value last documented longer ago than this before the latest document is worth a second look. */
export const STALE_AFTER_MONTHS = 6;

const RANK: Record<Light, number> = { green: 0, yellow: 1, red: 2 };

export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

export function monthName(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The traffic light of every fact and need, from the record alone: whether the task's need is
 * documented, how old its newest source is next to `asOf`, and whether a contradiction cites it.
 */
export function assess(
  needs: readonly Need[],
  contradictions: readonly Contradiction[],
  asOf: string,
): AssessedNeed[] {
  const conflicts = new Map<string, Contradiction>();
  for (const c of contradictions) for (const p of c.passages) conflicts.set(p.passageId, c);

  return needs.map((need) => {
    if (need.status === "not_documented")
      return {
        ...need,
        facts: [],
        light: "red",
        reason: need.note || "No document contains this.",
      };
    const facts = need.facts.map((fact): AssessedFact => {
      const conflict = fact.sources.map((s) => conflicts.get(s.passageId)).find(Boolean);
      if (conflict)
        return { ...fact, light: "yellow", reason: `Contradiction: ${conflict.summary}` };
      const newest =
        fact.sources
          .map((s) => s.documentDate)
          .sort()
          .at(-1) ?? asOf;
      const months = monthsBetween(newest, asOf);
      // A diagnosis stays true however long ago a letter last named it; drugs and values go stale.
      if (months > STALE_AFTER_MONTHS && fact.category !== "diagnosis")
        return {
          ...fact,
          light: "yellow",
          reason: `Last documented ${monthName(newest)}, ${months} months before the latest document.`,
        };
      return { ...fact, light: "green", reason: `Documented ${monthName(newest)}.` };
    });
    const worst = facts.reduce<Light>((w, f) => (RANK[f.light] > RANK[w] ? f.light : w), "green");
    const flagged = facts.filter((f) => f.light !== "green").length;
    return {
      ...need,
      facts,
      light: worst,
      reason: flagged
        ? `${flagged} of ${facts.length} to check.`
        : "Documented, current and consistent.",
    };
  });
}
