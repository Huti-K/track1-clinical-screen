/**
 * Runs the situations in cases/situations.md on a fresh store and writes each screen as Markdown
 * beside the expected answers, with an approximate grade (cases/rubric.ts), times and tokens. The
 * cases stay out of the repository, so this runs only where they are.
 *
 *   pnpm eval                                  the configured model (.env), into output/eval
 *   pnpm eval --only 2,4                       only situations 2 and 4
 *   pnpm eval --run openai-codex/gpt-6-luna@low/high:context [--run ...]
 *                                              one benchmark run per spec, into output/bench
 *                                              (model@screenThinking/scanThinking:retrieval+backgroundModel)
 *   pnpm eval --set heldout|all                 the held-out situations (cases/rubric.ts), or both
 *   pnpm eval --run spec#a --run spec#b        the same spec twice, as separate runs
 *   pnpm eval --report                         one table of every run in output/bench
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai/providers/model-schema";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Contradiction, ScreenResponse, Source } from "@track1/shared";
import type { Retrieval } from "../src/agent/clinical.js";
import { config, parseModel } from "../src/config.js";
import { openConfigured } from "../src/open.js";
import { gradeAnswer, gradeContradictions, loadRubric } from "./rubric.js";

const root = resolve(import.meta.dirname, "../../..");
const rubric = await loadRubric(join(root, "cases/rubric.ts"));
type Expected = { id: string; question: string; answer: string; sources: string[] };

type RunSpec = {
  label: string;
  model?: string;
  screen?: ModelThinkingLevel;
  scan?: ModelThinkingLevel;
  retrieval?: Retrieval;
  background?: string;
};

type Tokens = { input: number; cacheRead: number; output: number; cost: number };

type RunSummary = {
  label: string;
  model: string;
  scanMs: number;
  indexMs?: number;
  indexFacts?: number;
  review?: { corrected: number; dropped: number };
  contradictions: { found: number; known: string[]; missed: string[]; unmatched: string[] };
  screens: {
    n: number;
    title: string;
    ms: number;
    facts: number;
    answers: Record<string, boolean>;
  }[];
  tokens: { scan: Tokens; screens: Tokens };
};

function situations(): { number: number; title: string; text: string }[] {
  const markdown = readFileSync(join(root, "cases/situations.md"), "utf8");
  // Title and description only; the questions after them are for grading, never for the model.
  return [...markdown.matchAll(/^## (\d+)\. (.+)\n\n([\s\S]+?)\n\n1\./gm)].map((match) => ({
    number: Number(match[1]),
    title: match[2]?.trim() ?? "",
    text: `${match[2]?.trim()}. ${match[3]?.replace(/\s+/g, " ").trim()}`,
  }));
}

/** `provider/model@screen/scan:retrieval+backgroundModel#tag`, every part after the model optional. */
function parseRun(spec: string): RunSpec {
  const [main = "", background] = (spec.split("#")[0] ?? "").split("+");
  const [model, rest = ""] = main.split(/@(?=[^@]*$)/);
  const [thinking = "", retrieval] = rest.split(":");
  const [screen, scan] = thinking.split("/");
  return {
    label: spec.replace(/[^\w.-]+/g, "_"),
    ...(model ? { model } : {}),
    ...(screen ? { screen: screen as ModelThinkingLevel } : {}),
    ...(scan ? { scan: scan as ModelThinkingLevel } : {}),
    ...(retrieval ? { retrieval: retrieval as Retrieval } : {}),
    ...(background ? { background } : {}),
  };
}

function sum(usage: Record<string, Usage>): Tokens {
  const all = Object.values(usage);
  return {
    input: all.reduce((n, u) => n + u.input, 0),
    cacheRead: all.reduce((n, u) => n + u.cacheRead, 0),
    output: all.reduce((n, u) => n + u.output, 0),
    cost: all.reduce((n, u) => n + (u.cost?.total ?? 0), 0),
  };
}

const minus = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input - b.input,
  cacheRead: a.cacheRead - b.cacheRead,
  output: a.output - b.output,
  cost: a.cost - b.cost,
});

const cite = (s: Source) => `[${s.documentTitle}, ${s.documentDate}, ${s.passageId}] "${s.quote}"`;

function contradictionLines(list: (Contradiction & { relevant?: boolean })[]): string[] {
  return list.flatMap((c) => [
    `- ${c.relevant ? "**(affects this screen)** " : ""}${c.summary}`,
    ...c.passages.map((p) => `  - ${cite(p)}`),
  ]);
}

function render(
  title: string,
  response: ScreenResponse,
  ms: number,
  expected: Expected[],
  answers: Record<string, boolean>,
): string {
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
        `- [${fact.light}] **${fact.label}:** ${fact.value}${fact.detail ? ` — ${fact.detail}` : ""} (${fact.reason})`,
        ...fact.sources.map((s) => `  - ${cite(s)}`),
      ]),
      "",
    ]),
    ...response.checks.flatMap((check) => [
      `## [CHECK] ${check.title} — ${check.rule}`,
      ...check.items.flatMap((item) => [
        `- [${item.light}] **${item.tag}:** ${item.value} (${item.reason})`,
        ...item.sources.map((s) => `  - ${cite(s)}`),
      ]),
      ...check.gaps.map((gap) => `- **not documented: ${gap.title}** ${gap.note} ${gap.action}`),
      "",
    ]),
    "## Expected answers (cases/expected.json), graded by cases/rubric.ts",
    ...expected.map(
      (e) =>
        `- **${answers[e.id] ? "PASS" : "MISS"} ${e.id} ${e.question}** ${e.answer} (${e.sources.join(", ") || "-"})`,
    ),
    "",
    "## Contradictions",
    ...contradictionLines(response.contradictions),
    "",
  ].join("\n");
}

async function run(
  spec: RunSpec,
  outDir: string,
  only: number[],
  set: string,
): Promise<RunSummary> {
  // Built before the first screen whenever screens use it, so no screen's time includes it.
  const retrieval = spec.retrieval ?? config.retrieval;
  const expected = [
    ...(JSON.parse(readFileSync(join(root, "cases/expected.json"), "utf8")) as Expected[]),
    ...rubric.heldoutExpected.map((e) => ({ ...e, sources: [] })),
  ];
  const chosen = [
    ...(set === "heldout" ? [] : situations()),
    ...(set === "known" ? [] : rubric.heldout),
  ];
  const { runtimes, login } = await openConfigured(
    (message, error) => console.warn(`[${spec.label}] ${message}`, error ?? ""),
    {
      // A fresh store per run, so every screen is generated and timed.
      storage: () => new MemoryStorage(),
      timeoutMs: 300_000,
      ...(spec.model ? { model: parseModel(spec.model) } : {}),
      ...(spec.screen || spec.scan
        ? { thinking: { screen: spec.screen ?? "off", scan: spec.scan ?? "medium" } }
        : {}),
      ...(spec.retrieval ? { retrieval: spec.retrieval } : {}),
      ...(spec.background ? { backgroundModel: parseModel(spec.background) } : {}),
    },
  );
  try {
    const runtime = runtimes.find((r) => r.record.summary.id === rubric.patient);
    if (!runtime)
      throw new Error(`Patient ${rubric.patient}, whose situations these are, is missing.`);
    if (!(await login.signedIn()))
      throw new Error(`Not signed in to ${runtime.modelName}. Sign in in the app or set a key.`);
    mkdirSync(outDir, { recursive: true });
    const context = BACKGROUND_CONTEXT;
    let started = Date.now();
    const found = await runtime.contradictions();
    const scanMs = Date.now() - started;
    const afterScan = sum((await runtime.harness.usage(context)).models);
    const graded = gradeContradictions(rubric, found);
    console.log(`[${spec.label}] scan: ${found.length} in ${(scanMs / 1000).toFixed(1)} s`);
    let index: { ms: number; facts: number } | undefined;
    if (retrieval === "index") {
      started = Date.now();
      const facts = await runtime.factIndex();
      index = { ms: Date.now() - started, facts: facts.length };
      console.log(
        `[${spec.label}] index: ${facts.length} facts in ${(index.ms / 1000).toFixed(1)} s`,
      );
    }
    const afterBackground = sum((await runtime.harness.usage(context)).models);

    const screens: RunSummary["screens"] = [];
    for (const situation of chosen.filter((s) => !only.length || only.includes(s.number))) {
      started = Date.now();
      const response = await runtime.screen(situation.text);
      const ms = Date.now() - started;
      const mine = expected.filter((e) => e.id.startsWith(`${situation.number}.`));
      const answers = Object.fromEntries(
        mine.map((e) => [e.id, gradeAnswer(rubric, e.id, response.screen)]),
      );
      const slug = situation.title.toLowerCase().replace(/\W+/g, "-");
      writeFileSync(
        join(outDir, `${situation.number}-${slug}.md`),
        render(`${situation.number}. ${situation.title}`, response, ms, mine, answers),
      );
      const facts = response.screen.needs.reduce((n, need) => n + need.facts.length, 0);
      screens.push({ n: situation.number, title: situation.title, ms, facts, answers });
      const passed = Object.values(answers).filter(Boolean).length;
      console.log(
        `[${spec.label}] ${situation.number}. ${(ms / 1000).toFixed(1)} s, ${facts} facts, ${passed}/${mine.length} answers`,
      );
    }
    const summary: RunSummary = {
      label: spec.label,
      model: runtime.modelName,
      scanMs,
      ...(index ? { indexMs: index.ms, indexFacts: index.facts } : {}),
      ...(retrieval === "index" ? { review: await runtime.indexReview() } : {}),
      contradictions: {
        found: found.length,
        known: graded.known,
        missed: graded.missed,
        unmatched: graded.unmatched.map((c) => c.summary),
      },
      screens,
      tokens: {
        scan: afterScan,
        screens: minus(sum((await runtime.harness.usage(context)).models), afterBackground),
      },
    };
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(
      join(outDir, "contradictions.md"),
      [`# Contradictions (${found.length})`, ...contradictionLines(found), ""].join("\n"),
    );
    return summary;
  } finally {
    await Promise.all(runtimes.map((r) => r.close()));
  }
}

function report(benchDir: string): string {
  const runs = readdirSync(benchDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [
          JSON.parse(
            readFileSync(join(benchDir, entry.name, "summary.json"), "utf8"),
          ) as RunSummary,
        ];
      } catch {
        return [];
      }
    });
  const rows = runs.map((r) => {
    const answers = r.screens.flatMap((s) => Object.values(s.answers));
    const times = r.screens.map((s) => s.ms / 1000).sort((a, b) => a - b);
    const t = r.tokens.screens;
    return `| ${r.label} | ${answers.filter(Boolean).length}/${answers.length} | ${r.contradictions.known.length} known + ${r.contradictions.unmatched.length} other | ${times.at(-1)?.toFixed(1)} s | ${times[Math.floor(times.length / 2)]?.toFixed(1)} s | ${(r.scanMs / 1000).toFixed(0)} s | ${t.input} / ${t.cacheRead} / ${t.output} |`;
  });
  return [
    "# Benchmark",
    "",
    "Answers and known contradictions are graded by cases/rubric.ts; read the misses and the other contradictions before trusting a number.",
    "",
    "| Run | Answers | Contradictions | Slowest screen | Median screen | Scan | Screen tokens in / cached / out |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const benchDir = join(root, "output", "bench");
if (args.includes("--report")) {
  const table = report(benchDir);
  writeFileSync(join(benchDir, "report.md"), table);
  console.log(table);
} else {
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? "").split(",").map(Number) : [];
  const setAt = args.indexOf("--set");
  const set = setAt >= 0 ? (args[setAt + 1] ?? "known") : "known";
  const specs = args.flatMap((arg, i) => (args[i - 1] === "--run" ? [parseRun(arg)] : []));
  if (specs.length === 0) await run({ label: "eval" }, join(root, "output", "eval"), only, set);
  for (const spec of specs) await run(spec, join(benchDir, spec.label), only, set);
}
