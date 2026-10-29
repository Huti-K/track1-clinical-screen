/**
 * Runs the situations in cases/situations.md against a fresh store and writes one Markdown screen
 * per situation, with the expected answers beside it, plus a summary of the README's metrics.
 *
 *   pnpm eval                 all five situations
 *   pnpm eval 2 4             only situations 2 and 4
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Contradiction, ScreenResponse, Source } from "@track1/shared";

const root = resolve(import.meta.dirname, "../../..");
const outDir = join(root, "output", "eval");
// A fresh store, so every screen is generated and timed rather than served from a previous run.
process.env.STORE_PATH ??= join(".data", `eval-${Date.now()}.sqlite`);
const { openConfigured } = await import("../src/open.js");

type Expected = { id: string; question: string; answer: string; sources: string[] };

function situations(): { number: number; title: string; text: string }[] {
  const markdown = readFileSync(join(root, "cases/situations.md"), "utf8");
  return [...markdown.matchAll(/^## (\d+)\. (.+)\n\n([\s\S]+?)\n\n1\./gm)].map((match) => ({
    number: Number(match[1]),
    title: match[2]?.trim() ?? "",
    text: `${match[2]?.trim()}. ${match[3]?.replace(/\s+/g, " ").trim()}`,
  }));
}

const cite = (s: Source) => `[${s.documentTitle}, ${s.documentDate}, ${s.passageId}] "${s.quote}"`;

function contradictionLines(list: (Contradiction & { relevant?: boolean })[]): string[] {
  return list.flatMap((c) => [
    `- ${c.relevant ? "**(affects this screen)** " : ""}${c.summary}`,
    ...c.passages.map((p) => `  - ${cite(p)}`),
  ]);
}

function render(title: string, response: ScreenResponse, ms: number, expected: Expected[]): string {
  const { screen } = response;
  return [
    `# ${title}`,
    "",
    `> ${screen.situation}`,
    "",
    `**${screen.role} — ${screen.task}** · ${(ms / 1000).toFixed(1)} s · ${screen.model}${screen.rejected ? ` · ${screen.rejected} unverifiable fact(s) left out` : ""}`,
    "",
    ...screen.needs.flatMap((need) => [
      `## [${need.light.toUpperCase()}] ${need.title} — ${need.reason}`,
      ...need.facts.flatMap((fact) => [
        `- [${fact.light}] **${fact.label}:** ${fact.value} (${fact.reason})`,
        ...fact.sources.map((s) => `  - ${cite(s)}`),
      ]),
      "",
    ]),
    `Lights: ${response.summary.green} green, ${response.summary.yellow} yellow, ${response.summary.red} red`,
    "",
    "## Contradictions",
    ...contradictionLines(response.contradictions),
    "",
    "## Expected answers (cases/expected.json)",
    ...expected.map(
      (e) => `- **${e.id} ${e.question}** ${e.answer} (${e.sources.join(", ") || "-"})`,
    ),
    "",
  ].join("\n");
}

const only = process.argv.slice(2).map(Number);
const expected = JSON.parse(readFileSync(join(root, "cases/expected.json"), "utf8")) as Expected[];
const { runtime, login } = await openConfigured((message, error) =>
  console.warn(message, error ?? ""),
);
if (!(await login.signedIn())) {
  console.error(
    `Not signed in to ${runtime.modelName}. Run pnpm dev and sign in, or set an API key in .env.`,
  );
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

console.log(`Model ${runtime.modelName}; store ${process.env.STORE_PATH}`);
let started = Date.now();
const contradictions = await runtime.contradictions();
console.log(
  `Contradiction scan: ${contradictions.length} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);

const rows: string[] = [];
for (const situation of situations().filter((s) => !only.length || only.includes(s.number))) {
  started = Date.now();
  const response = await runtime.screen(situation.text);
  const ms = Date.now() - started;
  const mine = expected.filter((e) => e.id.startsWith(`${situation.number}.`));
  const file = join(
    outDir,
    `${situation.number}-${situation.title.toLowerCase().replace(/\W+/g, "-")}.md`,
  );
  writeFileSync(file, render(`${situation.number}. ${situation.title}`, response, ms, mine));
  const facts = response.screen.needs.reduce((n, need) => n + need.facts.length, 0);
  const missing = response.screen.needs.filter((n) => n.status === "not_documented").length;
  rows.push(
    `| ${situation.number}. ${situation.title} | ${(ms / 1000).toFixed(1)} s | ${response.screen.needs.length} | ${facts} | ${missing} | ${response.screen.rejected} |`,
  );
  console.log(
    `${situation.number}. ${situation.title}: ${(ms / 1000).toFixed(1)} s, ${facts} facts -> ${file}`,
  );
}

writeFileSync(
  join(outDir, "summary.md"),
  [
    "# Evaluation",
    "",
    `Model: ${runtime.modelName}. Every fact on a screen passed the quote check against its passage; facts that failed it are counted as left out.`,
    "",
    "| Situation | Load time | Needs | Facts | Not documented | Left out |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `## Contradictions (${contradictions.length})`,
    ...contradictionLines(contradictions),
    "",
  ].join("\n"),
);
console.log(`Summary -> ${join(outDir, "summary.md")}`);
await runtime.close();
