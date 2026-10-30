import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadPatientRecord } from "@track1/patient-record";
import type { Answer, Note, OverviewResponse, ScreenResponse } from "@track1/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ClinicalRuntime } from "../src/agent/runtime.js";
import { buildApp } from "../src/app.js";

const FIXTURE = join(import.meta.dirname, "fixtures/patient");
/** The fixture patient's routes. */
const PATIENT = "/api/patients/9999-0001";
const SITUATION = "Anaesthetist, pre-operative check before hip surgery";

const BMI_CONTRADICTION = {
  contradictions: [
    {
      summary: "BMI 33.5 does not match 84 kg at 165 cm (30.9).",
      passages: [
        { passage: "D1-6", quote: "BMI: 33.5" },
        { passage: "D1-4", quote: "165 cm" },
        { passage: "D1-5", quote: "84 kg" },
      ],
    },
  ],
};

function screenArgs(aspirinQuote: string): JsonObject {
  return {
    role: "Anaesthetist",
    task: "Pre-operative check",
    needs: [
      {
        title: "Blood thinners",
        status: "documented",
        facts: [
          {
            label: "Antiplatelet",
            value: "Aspirin (Thrombo ASS) 100 mg, 1-0-0",
            sources: [{ passage: "D1-9", quote: aspirinQuote }],
          },
        ],
      },
      {
        title: "Allergies",
        status: "documented",
        facts: [
          {
            label: "Contrast media",
            value: "Contrast media allergy (nausea, vomiting)",
            sources: [{ passage: "D1-2", quote: "KM-Allergie (Übelkeit, Erbrechen)" }],
          },
        ],
      },
      { title: "Kidney function", status: "not_documented", facts: [], note: "No creatinine." },
    ],
  };
}

/** What the fact index builder extracts from the fixture; f2 and f3 claim more than their quotes. */
const INDEX: JsonObject = {
  facts: [
    {
      category: "allergy",
      label: "Contrast media",
      value: "Contrast media allergy with nausea and vomiting",
      detail: " nausea, vomiting ",
      date: "2019-06-28",
      sources: [{ passage: "D1-2", quote: "KM-Allergie (Übelkeit, Erbrechen)" }],
    },
    {
      category: "medication",
      label: "Aspirin (Thrombo ASS)",
      value: "100 mg orally, 1-0-0, started after a stroke",
      detail: "",
      date: "2019-06-28",
      drug: { name: "Aspirin", brand: "Thrombo ASS", dose: "100 mg", schedule: "1-0-0", route: "" },
      sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg oral 1 0 0 0" }],
    },
    {
      category: "measurement",
      label: "BMI",
      value: "BMI 33.5, obese since childhood",
      date: "2019-06-28",
      sources: [{ passage: "D1-6", quote: "BMI: 33.5" }],
    },
    {
      category: "diagnosis",
      label: "T2DM",
      value: "Type 2 diabetes",
      date: "2019-06-28",
      sources: [{ passage: "D1-15", quote: "Diab. mell. Typ II" }],
    },
    {
      category: "diagnosis",
      label: "HTN",
      value: "Arterial hypertension",
      date: "2019-06-28",
      sources: [{ passage: "D1-16", quote: "Art. Hypertonie" }],
    },
    {
      category: "diagnosis",
      label: "T2DM",
      value: "Type 2 diabetes",
      date: "2020-04-05",
      sources: [{ passage: "D2-6", quote: "Diab. mell. Typ II" }],
    },
    {
      category: "diagnosis",
      label: "Pneumonia",
      value: "Ruled out",
      date: "2020-04-05",
      sources: [{ passage: "D2-7", quote: "Pneumonie ausgeschlossen" }],
    },
  ],
};

/** The review of INDEX by label: the aspirin is corrected, the BMI has no support and leaves the index. */
const REVIEW: Record<string, JsonObject> = {
  "Aspirin (Thrombo ASS)": { verdict: "corrected", value: "100 mg orally, 1-0-0" },
  BMI: { verdict: "unsupported" },
};

/** The INDEX facts of the part the prompt names, as a model indexing only that part would give. */
function indexOfPart(prompt: string): JsonObject {
  const documentId = /Your part: passages (\w+)-\d+ to/.exec(prompt)?.[1];
  const facts = (INDEX.facts as JsonObject[]).filter((fact) =>
    (fact.sources as JsonObject[]).some((s) => String(s.passage).startsWith(`${documentId}-`)),
  );
  return { facts };
}

/** A verdict for every fact the review prompt lists, from REVIEW or else supported. */
function reviewOf(prompt: string): JsonObject {
  const listed = [...prompt.matchAll(/\[(f\d+)\] \w+ [\d-]+ \| ([^|]+?) \|/g)];
  return {
    reviews: listed.map(([, id = "", label = ""]) => ({
      id,
      ...(REVIEW[label] ?? { verdict: "supported" }),
    })),
  };
}

type Script = (attempt: number) => JsonObject;

/**
 * Answers like a model would: the index builder gets INDEX, its review REVIEW, the contradiction
 * scan its report, a screen gets `screen(attempt)` and a follow-up question `answer(attempt)`.
 * The index and the scan answer only once `held` settles.
 */
function scriptedModels(screen: Script, answer?: Script, held?: Promise<void>) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "clinic-1" }] });
  const respond: FauxResponseFactory = async (context) => {
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (["report_contradictions", "submit_index", "submit_review"].some((t) => tools.includes(t)))
      await held;
    if (tools.includes("report_contradictions"))
      return fauxAssistantMessage(fauxToolCall("report_contradictions", BMI_CONTRADICTION), {
        stopReason: "toolUse",
      });
    const prompt = JSON.stringify(context.messages);
    if (tools.includes("submit_index"))
      return fauxAssistantMessage(fauxToolCall("submit_index", indexOfPart(prompt)), {
        stopReason: "toolUse",
      });
    if (tools.includes("submit_review"))
      return fauxAssistantMessage(fauxToolCall("submit_review", reviewOf(prompt)), {
        stopReason: "toolUse",
      });
    const attempt = context.messages.filter((m) => m.role === "toolResult").length + 1;
    if (tools.includes("submit_answer") && answer)
      return fauxAssistantMessage(fauxToolCall("submit_answer", answer(attempt)), {
        stopReason: "toolUse",
      });
    return fauxAssistantMessage(fauxToolCall("submit_screen", screen(attempt)), {
      stopReason: "toolUse",
    });
  };
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple(model, context, options) {
      faux.setResponses([respond]);
      return faux.provider.streamSimple(model, context, options);
    },
  });
  return models;
}

const open: { app: FastifyInstance; runtime: ClinicalRuntime }[] = [];

async function start(
  storage: Storage,
  screen: Script,
  retrieval: "context" | "index" = "context",
  answer?: Script,
  held?: Promise<void>,
) {
  const runtime = await ClinicalRuntime.open({
    storage,
    models: scriptedModels(screen, answer, held),
    model: { provider: "faux", modelId: "clinic-1" },
    record: await loadPatientRecord(FIXTURE),
    retrieval,
  });
  const app = await buildApp([runtime]);
  open.push({ app, runtime });
  // The overview waits for the index and the scan, as a clinician's first screen no longer does.
  if (retrieval === "index" && !held)
    expect((await app.inject({ method: "GET", url: `${PATIENT}/overview` })).statusCode).toBe(200);
  return app;
}

async function postScreen(app: FastifyInstance, situation = SITUATION): Promise<ScreenResponse> {
  const response = await app.inject({
    method: "POST",
    url: `${PATIENT}/screens`,
    payload: { situation },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ScreenResponse>();
}

afterEach(async () => {
  for (const { app, runtime } of open.splice(0)) {
    await app.close();
    await runtime.close();
  }
});

describe("POST /api/patients/:patientId/screens", () => {
  it("links every fact to the passage that says it, after the model fixes a misquote", async () => {
    // The first submission quotes a dose the row does not contain; the tool rejects it.
    const app = await start(new MemoryStorage(), (attempt) =>
      screenArgs(attempt === 1 ? "Thrombo ASS 300mg" : "Thrombo ASS 100mg oral 1 0 0 0"),
    );

    const { screen, contradictions, cached } = await postScreen(app);

    expect(cached).toBe(false);
    expect(screen.rejected).toBe(0);
    const aspirin = screen.needs.find((need) => need.title === "Blood thinners")?.facts[0];
    expect(aspirin?.sources).toEqual([
      {
        passageId: "D1-9",
        documentId: "D1",
        documentTitle: "Stat. Patientenbrief",
        documentDate: "2019-06-28",
        quote: "Thrombo ASS 100mg oral 1 0 0 0",
      },
    ]);
    expect(screen.needs.find((need) => need.title === "Kidney function")).toMatchObject({
      status: "not_documented",
      facts: [],
    });
    // The model reports the BMI mismatch too; the arithmetic check finds it and keeps one copy.
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({ method: "rule", relevant: false });
    expect(contradictions[0]?.summary).toContain("30.9");
    expect(contradictions[0]?.passages.map((p) => p.passageId).sort()).toEqual([
      "D1-4",
      "D1-5",
      "D1-6",
    ]);

    const document = await app.inject({ method: "GET", url: `${PATIENT}/documents/D1` });
    const cited = document.json<{ passages: { id: string; text: string }[] }>().passages;
    expect(cited.find((p) => p.id === "D1-9")?.text).toBe("Thrombo ASS 100mg oral 1 0 0 0 ST");
  });

  it("leaves a fact off the screen when the model keeps citing a passage that does not say it", async () => {
    const app = await start(new MemoryStorage(), () => screenArgs("Thrombo ASS 300mg"));

    const { screen } = await postScreen(app);

    expect(screen.rejected).toBe(1);
    expect(screen.needs.map((need) => need.title)).toEqual(["Allergies", "Kidney function"]);
  });

  it("serves a finished screen from the store after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "track1-"));
    try {
      const path = join(directory, "agent.sqlite");
      const first = await start(await openNodeSqliteStorage(path), () =>
        screenArgs("Thrombo ASS 100mg"),
      );
      const before = await postScreen(first);
      const { app, runtime } = open.splice(0)[0] as (typeof open)[number];
      await app.close();
      await runtime.close();

      // A model that would only ever misquote proves the second answer comes from the store.
      const second = await start(await openNodeSqliteStorage(path), () => screenArgs("never said"));
      const after = await postScreen(second);

      expect(after.cached).toBe(true);
      expect(after.screen.needs).toEqual(before.screen.needs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves screens from the reviewed index, picked by ID rather than rewritten", async () => {
    // One submission picks the fact the review removed and rewrites an indexed passage itself.
    const app = await start(
      new MemoryStorage(),
      () => ({
        role: "Anaesthetist",
        task: "Pre-operative check",
        needs: [
          {
            title: "Blood thinners and allergies",
            status: "documented",
            factIds: ["f1", "f3"],
            facts: [
              {
                label: "Aspirin",
                value: "Aspirin 100 mg daily",
                sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg" }],
              },
            ],
          },
        ],
      }),
      "index",
    );

    const { screen } = await postScreen(app);

    // f3 left the index in its review; the rewritten aspirin becomes f2 as the review corrected it.
    expect(screen.needs[0]?.facts.map((f) => [f.value, f.sources[0]?.passageId])).toEqual([
      ["Contrast media allergy with nausea and vomiting", "D1-2"],
      ["100 mg orally, 1-0-0", "D1-9"],
    ]);
    // A picked fact keeps its parts, trimmed, without the empty ones.
    const [allergy, aspirin] = screen.needs[0]?.facts ?? [];
    expect(allergy).toMatchObject({ detail: "nausea, vomiting", date: "2019-06-28" });
    expect(aspirin?.drug).toEqual({
      name: "Aspirin",
      brand: "Thrombo ASS",
      dose: "100 mg",
      schedule: "1-0-0",
    });
    expect(aspirin).not.toHaveProperty("detail");
  });

  it("serves a screen from the whole record while the index and the scan are still running, and keeps it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await start(
      new MemoryStorage(),
      () => ({
        role: "Anaesthetist",
        task: "Pre-operative check",
        needs: [
          {
            title: "Blood thinners",
            status: "documented",
            factIds: ["f1"],
            facts: [
              {
                label: "Aspirin",
                value: "Aspirin 100 mg daily",
                sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg" }],
              },
            ],
          },
        ],
      }),
      "index",
      undefined,
      held,
    );

    // Held, the index and the scan would make the old screen wait forever.
    const { screen } = await postScreen(app);

    // The model's own fact rather than an index pick: there is no index yet.
    expect(screen.needs[0]?.facts.map((f) => [f.value, f.sources[0]?.passageId])).toEqual([
      ["Aspirin 100 mg daily", "D1-9"],
    ]);
    release();
    expect((await app.inject({ method: "GET", url: `${PATIENT}/overview` })).statusCode).toBe(200);

    // Asked again once the index is ready, the situation keeps the screen it got.
    const again = await postScreen(app);
    expect(again.cached).toBe(true);
    expect(again.screen.needs[0]?.facts.map((f) => f.value)).toEqual(["Aspirin 100 mg daily"]);
  });

  it("keeps the occasion and the detail, date and drug parts of a fact the screen writes", async () => {
    const app = await start(new MemoryStorage(), () => ({
      role: "Anaesthetist",
      task: "Pre-operative check",
      occasion: " Hip surgery, 16 May 2020 ",
      needs: [
        {
          title: "Blood thinners",
          status: "documented",
          facts: [
            {
              label: "Antiplatelet",
              value: "Aspirin 100 mg",
              detail: "1-0-0, oral",
              date: "2019-06-28",
              drug: { name: "Aspirin", brand: "Thrombo ASS", dose: "100 mg", schedule: "1-0-0" },
              sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg oral 1 0 0 0" }],
            },
          ],
        },
      ],
    }));

    const { screen } = await postScreen(app);

    expect(screen.occasion).toBe("Hip surgery, 16 May 2020");
    expect(screen.needs[0]?.facts[0]).toMatchObject({
      value: "Aspirin 100 mg",
      detail: "1-0-0, oral",
      date: "2019-06-28",
      drug: { name: "Aspirin", brand: "Thrombo ASS", dose: "100 mg", schedule: "1-0-0" },
    });
  });

  it("charts a measurement the screen cites across every document that states it", async () => {
    const app = await start(new MemoryStorage(), () => ({
      role: "General practitioner",
      task: "Diabetes review",
      needs: [
        {
          title: "Weight",
          status: "documented",
          facts: [
            {
              label: "Weight",
              value: "79 kg (Apr 2020)",
              sources: [{ passage: "D2-3", quote: "Gewicht: 79 kg" }],
            },
          ],
        },
      ],
    }));

    const { trends, passages } = await postScreen(app);

    // 84 kg in June 2019 and 79 kg in April 2020; one blood pressure is no trend.
    expect(trends).toHaveLength(1);
    expect(trends[0]).toMatchObject({ kind: "weight", change: "−5 kg since Jun 2019" });
    expect(
      trends[0]?.points.map((p) => [p.display, p.date, p.sources.map((s) => s.passageId)]),
    ).toEqual([
      ["84 kg", "2019-06-28", ["D1-5"]],
      ["79 kg", "2020-04-05", ["D2-3"]],
    ]);
    expect(passages["D1-5"]?.text).toBe("Gewicht: 84 kg");
  });

  it("keeps a missing need's next step and only the left-out topics a passage documents", async () => {
    const app = await start(new MemoryStorage(), () => ({
      ...screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
      needs: [
        {
          title: "Kidney function",
          status: "not_documented",
          facts: [],
          note: "No creatinine.",
          action: "Check creatinine before surgery",
        },
      ],
      leftOut: [
        { topic: "Blood pressure drug", sources: [{ passage: "D1-10", quote: "Blopress 8mg" }] },
        { topic: "Heart markers", sources: [{ passage: "D1-10", quote: "NT-proBNP 450 pg/ml" }] },
      ],
    }));

    const { screen } = await postScreen(app);

    expect(screen.needs[0]).toMatchObject({ action: "Check creatinine before surgery" });
    expect(screen.leftOut?.map((l) => [l.topic, l.sources[0]?.passageId])).toEqual([
      ["Blood pressure drug", "D1-10"],
    ]);
  });

  it("lists the drugs to review before an operation, and only the sick-day drugs for a diabetes review", async () => {
    const preop = await start(new MemoryStorage(), () =>
      screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
    );

    const { checks } = await postScreen(preop);

    // Candesartan is a sartan, not an ACE inhibitor; the pre-op leaflet lists aspirin as an
    // antiplatelet and says to stop a sartan on the morning of surgery under general anaesthesia.
    expect(checks.map((c) => c.kind)).toEqual(["surgery", "sickDay"]);
    expect(checks[0]?.items.map((i) => [i.tag, i.value, i.sources[0]?.passageId])).toEqual([
      ["Antiplatelet", "Thrombo ASS (aspirin) 100 mg oral 1-0-0", "D1-9"],
      ["Sartan", "Blopress (candesartan) 8 mg oral 1-0-½", "D1-10"],
      ["Metformin", "Glucophage (metformin) 1000 mg oral 1-1-1", "D1-11"],
    ]);
    expect(checks[0]?.items[1]?.detail).toMatch(
      /general anaesthesia stop on the morning of surgery/,
    );

    const review = await start(new MemoryStorage(), () => ({
      ...screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
      role: "General practitioner",
      task: "Diabetes review",
    }));
    const later = await postScreen(review, "General practitioner, diabetes review in spring 2020");
    // The NHS sick-day leaflet names sartans and metformin, not aspirin, and holds on every task.
    expect(later.checks.map((c) => c.kind)).toEqual(["sickDay"]);
    expect(later.checks[0]?.items.map((i) => [i.tag, i.sources[0]?.passageId])).toEqual([
      ["Sartan", "D1-10"],
      ["Metformin", "D1-11"],
    ]);
    expect(later.checks[0]?.items[0]?.detail).toMatch(/stop while dehydrated/);
  });

  it("before a CT lists the contrast allergy and metformin and asks for kidney function, though the screen left the allergy out", async () => {
    const app = await start(new MemoryStorage(), () => ({
      role: "Radiologist",
      task: "CT angiography of the neck",
      needs: [
        {
          title: "Blood thinners",
          status: "documented",
          facts: [
            {
              label: "Antiplatelet",
              value: "Aspirin (Thrombo ASS) 100 mg, 1-0-0",
              sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg oral 1 0 0 0" }],
            },
          ],
        },
      ],
    }));

    const { checks } = await postScreen(app, "Radiologist, CT angiography of the neck vessels");

    // No fact on the screen says the allergy, so the check quotes the letter.
    expect(checks.map((c) => c.kind)).toEqual(["contrast", "sickDay"]);
    expect(checks[0]?.items.map((i) => [i.tag, i.value, i.sources[0]?.passageId])).toEqual([
      ["Allergy", "KM-Allergie (Übelkeit, Erbrechen)", "D1-2"],
      ["Metformin", "Glucophage (metformin) 1000 mg oral 1-1-1", "D1-11"],
    ]);
    expect(checks[0]?.gaps.map((g) => g.title)).toEqual(["Kidney function"]);
  });

  it("before an MRI asks which agent caused the reaction and leaves metformin out", async () => {
    const app = await start(new MemoryStorage(), () => ({
      ...screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
      role: "Radiologist",
      task: "Contrast MRI of the liver",
    }));

    const { checks } = await postScreen(app, "Radiologist, contrast-enhanced MRI of the liver");

    // The allergy keeps the screen's wording; gadolinium is no reason to stop metformin.
    expect(checks[0]?.items.map((i) => [i.tag, i.value])).toEqual([
      ["Allergy", "Contrast media allergy (nausea, vomiting)"],
    ]);
    expect(checks[0]?.passages).toEqual(["D1-2"]);
    expect(checks[0]?.gaps.map((g) => g.title)).toEqual([
      "Kidney function",
      "Agent of the earlier reaction",
    ]);
  });

  it("refuses an empty situation", async () => {
    const app = await start(new MemoryStorage(), () => screenArgs("Thrombo ASS 100mg"));
    const response = await app.inject({
      method: "POST",
      url: `${PATIENT}/screens`,
      payload: { situation: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("lists what the screen leaves open, each gap once, with who can close it", async () => {
    const app = await start(
      new MemoryStorage(),
      (): JsonObject => ({
        role: "Radiologist",
        task: "CT angiography of the neck",
        needs: [
          {
            title: "Body measures",
            status: "documented",
            facts: [
              {
                label: "BMI",
                value: "BMI 33.5",
                sources: [{ passage: "D1-6", quote: "BMI: 33.5" }],
              },
            ],
          },
          {
            title: "Diabetes",
            status: "documented",
            facts: [
              {
                label: "HbA1c",
                value: "HbA1c 6.9 %",
                sources: [{ passage: "D1-13", quote: "HbA1c: 6,9 %" }],
              },
            ],
          },
          {
            title: "Kidneys",
            status: "not_documented",
            facts: [],
            note: "Creatinine, eGFR",
            action: "Order before CT",
          },
          {
            title: "Prior imaging",
            status: "not_documented",
            facts: [],
            note: "Earlier contrast CT",
            action: "Ask about earlier CT scans",
          },
          {
            title: "Duplex report",
            status: "not_documented",
            facts: [],
            note: "Carotid duplex result",
            action: "Request it from the vascular clinic",
          },
        ],
      }),
    );

    const { clarify } = await postScreen(app, "Radiologist, CT angiography of the neck vessels");

    // The contrast checklist's kidney gap stands for the screen's own "Kidneys" gap.
    expect(clarify.map((c) => [c.trigger, c.topic, c.from])).toEqual([
      ["gap", "Kidney function", "test"],
      ["gap", "Prior imaging", "patient"],
      ["gap", "Duplex report", "records"],
      ["contradiction", "BMI", "records"],
      ["old", "HbA1c", "test"],
    ]);
    const conflict = clarify[3];
    expect(conflict?.contradictionId).toBe("r-bmi-D1");
    expect(conflict?.sources.map((s) => s.passageId).sort()).toEqual(["D1-4", "D1-5", "D1-6"]);
    // The only HbA1c is from 28 June 2019, more than six months before the latest document.
    const old = clarify[4];
    expect(old?.reason).toContain("6.9 %");
    expect(old?.reason).toContain("Jun 2019");
    expect(old?.sources.map((s) => s.passageId)).toEqual(["D1-13"]);
  });

  it("shows her latest body measures, allergy and the diagnoses most documents name", async () => {
    const app = await start(
      new MemoryStorage(),
      () => screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
      "index",
    );

    const { basics } = await postScreen(app);

    // Height and weight from April 2020; the only BMI is from 2019 and contradicts its letter.
    expect(basics.measures.map((f) => [f.label, f.value, f.sources[0]?.passageId])).toEqual([
      ["Height", "166 cm", "D2-2"],
      ["Weight", "79 kg", "D2-3"],
      ["BMI", "33.5 kg/m²", "D1-6"],
    ]);
    expect(basics.measures[2]?.light).toBe("yellow");
    expect(basics.allergies.map((f) => [f.label, f.sources[0]?.passageId])).toEqual([
      ["Contrast media", "D1-2"],
    ]);
    // T2DM is in both letters, hypertension in one; the ruled-out pneumonia is no problem.
    expect(basics.problems.map((f) => [f.label, f.sources[0]?.passageId])).toEqual([
      ["T2DM", "D2-6"],
      ["HTN", "D1-16"],
    ]);
  });

  it("lists every drug of the latest medication table, whatever the screen picked", async () => {
    const app = await start(
      new MemoryStorage(),
      () => screenArgs("Thrombo ASS 100mg oral 1 0 0 0"),
      "index",
    );

    const { basics } = await postScreen(app);

    expect(
      basics.medication.map((f) => [
        f.drug?.name,
        f.drug?.dose,
        f.drug?.schedule,
        f.sources[0]?.passageId,
      ]),
    ).toEqual([
      ["Aspirin", "100 mg", "1-0-0", "D1-9"],
      ["Blopress", "8 mg", "1-0-½", "D1-10"],
      ["Glucophage", "1000 mg", "1-1-1", "D1-11"],
    ]);
  });

  it("flags a drug from nine months before the latest letter as old, but not a diagnosis", async () => {
    const app = await start(
      new MemoryStorage(),
      () => ({
        role: "General practitioner",
        task: "Diabetes review",
        needs: [{ title: "Diabetes", status: "documented", factIds: ["f4", "f2"], facts: [] }],
      }),
      "index",
    );

    const { screen } = await postScreen(app);

    const [diagnosis, drug] = screen.needs[0]?.facts ?? [];
    expect([diagnosis?.label, diagnosis?.light]).toEqual(["T2DM", "green"]);
    expect([drug?.label, drug?.light]).toEqual(["Aspirin (Thrombo ASS)", "yellow"]);
    expect(drug?.reason).toMatch(/9 months before/);
  });
});

describe("GET /api/patients/:patientId/overview", () => {
  it("charts what the documents state, each value linked to its passage, without building a screen", async () => {
    let screens = 0;
    const app = await start(new MemoryStorage(), () => {
      screens++;
      return screenArgs("Thrombo ASS 100mg oral 1 0 0 0");
    });
    const response = await app.inject({ method: "GET", url: `${PATIENT}/overview` });
    expect(response.statusCode).toBe(200);
    const { vitals, basics, contradictions } = response.json<OverviewResponse>();

    const weight = vitals.find((t) => t.kind === "weight");
    expect(weight?.points.map((p) => [p.display, p.sources[0]?.quote])).toEqual([
      ["84 kg", "Gewicht: 84 kg"],
      ["79 kg", "Gewicht: 79 kg"],
    ]);
    expect(weight?.change).toBe("−5 kg since Jun 2019");
    // Stated once: one point and no change, where a screen's trends would leave it out.
    const pressure = vitals.find((t) => t.kind === "bp");
    expect(pressure?.points.map((p) => [p.value, p.secondary, p.sources[0]?.quote])).toEqual([
      [138, 84, "138/84 mmHg"],
    ]);
    expect(pressure?.change).toBe("");
    expect(basics.measures.map((f) => f.label)).toEqual(["Height", "Weight", "BMI"]);
    expect(contradictions.length).toBeGreaterThan(0);
    expect(screens).toBe(0);
  });
});

describe("POST /api/patients/:patientId/answers", () => {
  const SITUATION_GP = "General practitioner, diabetes review in spring 2020";

  async function ask(app: FastifyInstance, question: string) {
    const response = await app.inject({
      method: "POST",
      url: `${PATIENT}/answers`,
      payload: { situation: SITUATION_GP, question },
    });
    expect(response.statusCode).toBe(200);
    return response.json<Answer>();
  }

  it("turns away keyboard mash instead of answering it", async () => {
    // The model would answer anything; the mash must not reach it.
    const app = await start(
      new MemoryStorage(),
      () => screenArgs("x"),
      "context",
      () => ({ topic: "Nonsense", facts: [], missing: { note: "Nothing in the documents" } }),
    );

    for (const question of ["asdfasdf", "sdkfjhsdkf jkjkjk"]) {
      const response = await app.inject({
        method: "POST",
        url: `${PATIENT}/answers`,
        payload: { situation: SITUATION_GP, question },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(/does not read as a question/);
    }
    expect((await ask(app, "Latest HbA1c?")).topic).toBe("Nonsense");
  });

  it("answers a follow-up question from the passage that says it, and again from the store", async () => {
    // The first answer quotes a value the passage does not contain; the tool rejects it.
    const app = await start(
      new MemoryStorage(),
      () => screenArgs("Thrombo ASS 100mg"),
      "context",
      (attempt) => ({
        topic: "HbA1c",
        facts: [
          {
            label: "HbA1c",
            value: "HbA1c 6.9 %",
            date: "2019-06-28",
            sources: [{ passage: "D1-13", quote: attempt === 1 ? "HbA1c: 7,1 %" : "HbA1c: 6,9 %" }],
          },
        ],
      }),
    );

    const answer = await ask(app, "What is her latest HbA1c?");

    expect(answer).toMatchObject({ topic: "HbA1c", rejected: 0, cached: false });
    expect(answer.missing).toBeUndefined();
    expect(answer.facts[0]?.sources).toEqual([
      {
        passageId: "D1-13",
        documentId: "D1",
        documentTitle: "Stat. Patientenbrief",
        documentDate: "2019-06-28",
        quote: "HbA1c: 6,9 %",
      },
    ]);
    // Nine months before the latest document, so the screen marks it old.
    expect(answer.facts[0]?.light).toBe("yellow");
    expect(answer.passages["D1-13"]?.text).toBe("HbA1c: 6,9 %");

    const again = await ask(app, "  what is her latest   HbA1c? ");
    expect(again.cached).toBe(true);
    expect(again.facts).toEqual(answer.facts);
  });

  it("says what no document answers rather than writing it as a fact", async () => {
    // The first answer states the gap as a fact; the tool sends it back.
    const app = await start(
      new MemoryStorage(),
      () => screenArgs("Thrombo ASS 100mg"),
      "context",
      (attempt): JsonObject =>
        attempt === 1
          ? {
              topic: "Carotid duplex",
              facts: [
                {
                  label: "Duplex",
                  value: "Not documented",
                  sources: [{ passage: "D1-9", quote: "Thrombo ASS 100mg" }],
                },
              ],
            }
          : {
              topic: "Carotid duplex",
              facts: [],
              missing: { note: "No carotid duplex", action: "Request the duplex report" },
            },
    );

    const answer = await ask(app, "Was the carotid duplex repeated?");

    expect(answer.facts).toEqual([]);
    expect(answer.missing).toEqual({
      note: "No carotid duplex",
      action: "Request the duplex report",
    });
  });
});

describe("/api/patients/:patientId/notes", () => {
  it("keeps what a clinician recorded across a restart until it is removed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "track1-notes-"));
    try {
      const path = join(directory, "agent.sqlite");
      const first = await start(await openNodeSqliteStorage(path), () => screenArgs("x"));
      const created = await first.inject({
        method: "POST",
        url: `${PATIENT}/notes`,
        payload: {
          topic: "Prior imaging",
          text: "CT with contrast in 2014, nausea afterwards",
          source: "patient",
          clarifies: "gap-prior-imaging",
        },
      });
      expect(created.statusCode).toBe(201);
      const note = created.json<Note>();
      expect(note).toMatchObject({
        topic: "Prior imaging",
        text: "CT with contrast in 2014, nausea afterwards",
        source: "patient",
        clarifies: "gap-prior-imaging",
      });
      expect(Date.parse(note.recordedAt)).not.toBeNaN();
      const empty = await first.inject({
        method: "POST",
        url: `${PATIENT}/notes`,
        payload: { topic: "Prior imaging", text: "   ", source: "patient" },
      });
      expect(empty.statusCode).toBe(400);
      const { app, runtime } = open.splice(0)[0] as (typeof open)[number];
      await app.close();
      await runtime.close();

      const second = await start(await openNodeSqliteStorage(path), () => screenArgs("x"));
      expect((await second.inject(`${PATIENT}/notes`)).json<Note[]>()).toEqual([note]);

      const url = `${PATIENT}/notes/${note.id}`;
      expect((await second.inject({ method: "DELETE", url })).statusCode).toBe(204);
      expect((await second.inject(`${PATIENT}/notes`)).json<Note[]>()).toEqual([]);
      expect((await second.inject({ method: "DELETE", url })).statusCode).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
