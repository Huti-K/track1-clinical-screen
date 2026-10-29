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
import type { ScreenResponse } from "@track1/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ClinicalRuntime } from "../src/agent/runtime.js";
import { buildApp } from "../src/app.js";

const FIXTURE = join(import.meta.dirname, "fixtures/patient");
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

/** Answers like a model would: the contradiction scan gets its report, a screen gets `screen(attempt)`. */
function scriptedModels(screen: (attempt: number) => JsonObject) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "clinic-1" }] });
  const respond: FauxResponseFactory = (context) => {
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (tools.includes("report_contradictions"))
      return fauxAssistantMessage(fauxToolCall("report_contradictions", BMI_CONTRADICTION), {
        stopReason: "toolUse",
      });
    const attempt = context.messages.filter((m) => m.role === "toolResult").length + 1;
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

async function start(storage: Storage, screen: (attempt: number) => JsonObject) {
  const runtime = await ClinicalRuntime.open({
    storage,
    models: scriptedModels(screen),
    model: { provider: "faux", modelId: "clinic-1" },
    record: await loadPatientRecord(FIXTURE),
  });
  const app = await buildApp(runtime);
  open.push({ app, runtime });
  return app;
}

async function postScreen(app: FastifyInstance): Promise<ScreenResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/api/screens",
    payload: { situation: SITUATION },
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

describe("POST /api/screens", () => {
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
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.passages.map((p) => p.passageId)).toEqual(["D1-6", "D1-4", "D1-5"]);

    const document = await app.inject({ method: "GET", url: "/api/documents/D1" });
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

  it("refuses an empty situation", async () => {
    const app = await start(new MemoryStorage(), () => screenArgs("Thrombo ASS 100mg"));
    const response = await app.inject({
      method: "POST",
      url: "/api/screens",
      payload: { situation: "" },
    });
    expect(response.statusCode).toBe(400);
  });
});
