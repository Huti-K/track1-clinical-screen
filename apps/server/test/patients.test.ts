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
import type { Note, PatientSummary, ScreenResponse } from "@track1/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ClinicalRuntime } from "../src/agent/runtime.js";
import { buildApp } from "../src/app.js";

/** A woman with a contrast allergy, and a man with a penicillin allergy and other drugs. */
const FIRST = join(import.meta.dirname, "fixtures/patient");
const SECOND = join(import.meta.dirname, "fixtures/second-patient");
const SITUATION = "Anaesthetist, pre-operative check before hip surgery";

type Cited = { passage: string; quote: string };
const ASPIRIN: Cited = { passage: "D1-9", quote: "Thrombo ASS 100mg oral 1 0 0 0" };
const ENTRESTO: Cited = { passage: "M1-5", quote: "Entresto 49/51mg oral 1 0 1 0" };

/** A screen with one fact per citation, as a model submits it. */
function screen(...citations: Cited[]): JsonObject {
  return {
    role: "Anaesthetist",
    task: "Pre-operative check",
    needs: [
      {
        title: "Medication",
        status: "documented",
        facts: citations.map((source) => ({
          label: "Drug",
          value: source.quote,
          sources: [source],
        })),
      },
    ],
  };
}

/** Every text a request carries: its system prompt, messages and tool declarations. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n");
  return "";
}

/** A model that submits `submitted` as the screen, finds no contradictions and keeps what it is sent. */
function scripted(submitted: JsonObject) {
  const seen: string[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "clinic-1" }] });
  const respond: FauxResponseFactory = (context) => {
    seen.push(textOf(context));
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    return fauxAssistantMessage(
      tools.includes("report_contradictions")
        ? fauxToolCall("report_contradictions", { contradictions: [] })
        : fauxToolCall("submit_screen", submitted),
      { stopReason: "toolUse" },
    );
  };
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple(model, context, options) {
      faux.setResponses([respond]);
      return faux.provider.streamSimple(model, context, options);
    },
  });
  return { models, seen };
}

const open: { app: FastifyInstance; runtimes: ClinicalRuntime[] }[] = [];

afterEach(async () => {
  for (const { app, runtimes } of open.splice(0)) {
    await app.close();
    for (const runtime of runtimes) await runtime.close();
  }
});

/** One patient's runtime on its own scripted model, and what that model is sent. */
async function openPatient(
  folder: string,
  submitted: JsonObject,
  storage: Storage = new MemoryStorage(),
) {
  const { models, seen } = scripted(submitted);
  const runtime = await ClinicalRuntime.open({
    storage,
    models,
    model: { provider: "faux", modelId: "clinic-1" },
    record: await loadPatientRecord(folder),
  });
  return { runtime, seen };
}

/** Both fixture patients behind one app, each with its own model and store. */
async function start(first: JsonObject, second: JsonObject) {
  const [a, b] = await Promise.all([openPatient(FIRST, first), openPatient(SECOND, second)]);
  const runtimes = [a.runtime, b.runtime];
  const app = await buildApp(runtimes);
  open.push({ app, runtimes });
  return { app, seen: { first: a.seen, second: b.seen } };
}

async function postScreen(app: FastifyInstance, patientId: string): Promise<ScreenResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/api/patients/${patientId}/screens`,
    payload: { situation: SITUATION },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ScreenResponse>();
}

describe("several patients", () => {
  it("sends each patient's model that patient's documents only", async () => {
    const { app, seen } = await start(screen(ASPIRIN), screen(ENTRESTO));

    const first = await postScreen(app, "9999-0001");
    const second = await postScreen(app, "9999-0002");

    expect([first.patient.id, second.patient.id]).toEqual(["9999-0001", "9999-0002"]);
    // The same situation for two patients is two screens, so no cache in the browser mixes them.
    expect(second.id).not.toBe(first.id);
    const sentFirst = seen.first.join("\n");
    const sentSecond = seen.second.join("\n");
    expect(sentFirst).toContain("KM-Allergie (Übelkeit, Erbrechen)");
    expect(sentFirst).not.toContain("Penicillin (Exanthem)");
    expect(sentSecond).toContain("Penicillin (Exanthem)");
    expect(sentSecond).not.toContain("KM-Allergie (Übelkeit, Erbrechen)");
    expect(sentSecond).not.toContain("Glucophage 1000mg");
    // Each model learns how the letters name its patient: him as a man, her as a woman.
    expect(sentSecond).toContain('"Beispielpatient"');
    expect(sentFirst).toContain('"Beispielpatientin"');
  });

  it("leaves out a fact that cites another patient's passage", async () => {
    // His screen also cites her aspirin row, which none of his documents has.
    const { app } = await start(screen(ASPIRIN), screen(ENTRESTO, ASPIRIN));

    const { screen: built, passages } = await postScreen(app, "9999-0002");

    expect(built.rejected).toBe(1);
    const cited = built.needs
      .flatMap((n) => n.facts.flatMap((f) => f.sources))
      .map((s) => s.passageId);
    expect(cited).toEqual(["M1-5"]);
    expect(passages).not.toHaveProperty("D1-9");
  });

  it("serves documents and notes only under the patient they belong to", async () => {
    const { app } = await start(screen(ASPIRIN), screen(ENTRESTO));

    const patients = (await app.inject("/api/patients")).json<PatientSummary[]>();
    expect(patients.map((p) => p.id)).toEqual(["9999-0001", "9999-0002"]);
    expect((await app.inject("/api/patients/9999-0002/documents/M1")).statusCode).toBe(200);
    expect((await app.inject("/api/patients/9999-0002/documents/D1")).statusCode).toBe(404);
    expect((await app.inject("/api/patients/9999-0003")).statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/patients/9999-0001/notes",
      payload: { topic: "Kidneys", text: "Creatinine 0.9 mg/dl today", source: "clinician" },
    });
    const note = created.json<Note>();
    expect((await app.inject("/api/patients/9999-0002/notes")).json<Note[]>()).toEqual([]);
    const elsewhere = `/api/patients/9999-0002/notes/${note.id}`;
    expect((await app.inject({ method: "DELETE", url: elsewhere })).statusCode).toBe(404);
    expect((await app.inject("/api/patients/9999-0001/notes")).json<Note[]>()).toEqual([note]);
  });

  it("refuses to open one patient's store for another patient", async () => {
    const directory = mkdtempSync(join(tmpdir(), "track1-store-"));
    try {
      const path = join(directory, "agent.sqlite");
      const { runtime } = await openPatient(FIRST, screen(), await openNodeSqliteStorage(path));
      await runtime.close();

      await expect(
        openPatient(SECOND, screen(), await openNodeSqliteStorage(path)),
      ).rejects.toThrow("belongs to patient 9999-0001");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Review before surgery", () => {
  it("lists each drug of the medication table, and elsewhere those with a dose after the name", async () => {
    const { app } = await start(screen(ASPIRIN), screen(ENTRESTO));

    const { checks } = await postScreen(app, "9999-0002");

    // A combined dose stays whole. His insulin pump has no dose, but its table row makes it a
    // drug he takes. His discharge letter names furosemide without a dose; the 5 mg in the next
    // sentence is bisoprolol's.
    expect(checks[0]?.items.map((i) => [i.tag, i.value, i.sources[0]?.passageId])).toEqual([
      ["Anticoagulant", "Eliquis (apixaban) 5 mg oral 1-0-1", "M1-4"],
      ["Sartan", "Entresto (sacubitril/valsartan) 49/51 mg oral 1-0-1", "M1-5"],
      ["Insulin", "NovoRapid (insulin) s.c.", "M1-7"],
      ["Diuretic", "Torem (torasemide) 10 mg oral 1-0-0", "M1-6"],
    ]);
  });
});
