import { existsSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import fastifyStatic from "@fastify/static";
import type { ErrorResponse } from "@track1/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type ClinicalRuntime, HttpError } from "./agent/runtime.js";
import type { SubscriptionLogin } from "./auth/login.js";

type PatientParams = { patientId: string };

/**
 * The API over one runtime per patient. Every patient route names its patient, and only that
 * patient's runtime answers it, from that patient's documents, model conversations and store.
 */
export async function buildApp(
  runtimes: readonly ClinicalRuntime[],
  options: {
    /** Without it every route is open, as in tests whose model needs no sign-in. */
    login?: SubscriptionLogin;
    webDist?: string;
    logger?: FastifyServerOptions["logger"];
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const { login } = options;
  const byId = new Map(runtimes.map((runtime) => [runtime.record.summary.id, runtime]));
  const runtimeOf = ({ patientId }: PatientParams) => {
    const runtime = byId.get(patientId);
    if (!runtime) throw new HttpError(404, `No patient ${patientId}.`);
    return runtime;
  };

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error instanceof HttpError ? error.statusCode : (error.statusCode ?? 500);
    if (status >= 500) request.log.error({ err: error }, "request failed");
    const body: ErrorResponse = { error: error.message };
    return reply.status(status).send(body);
  });

  if (login) {
    // Patient data and model runs only after sign-in; the sign-in routes themselves stay open.
    app.addHook("onRequest", async (request) => {
      if (!request.url.startsWith("/api/") || request.url.startsWith("/api/auth")) return;
      if (!(await login.signedIn())) throw new HttpError(401, "Sign in first.");
    });
    app.get("/api/auth", async () => login.status());
    app.post<{ Body: { method?: "browser" | "device" } }>(
      "/api/auth/login",
      {
        schema: {
          body: Type.Object({
            method: Type.Optional(Type.Union([Type.Literal("browser"), Type.Literal("device")])),
          }),
        },
      },
      async (request) => login.start(request.body.method ?? "browser"),
    );
    app.post<{ Body: { value: string } }>(
      "/api/auth/login/input",
      { schema: { body: Type.Object({ value: Type.String({ minLength: 1 }) }) } },
      async (request) => {
        login.input(request.body.value);
        return login.status();
      },
    );
    app.post("/api/auth/cancel", async () => {
      login.cancel();
      return login.status();
    });
    app.post("/api/auth/logout", async () => {
      await login.logout();
      return login.status();
    });
  }

  app.get("/api/patients", async () => runtimes.map((runtime) => runtime.record.summary));

  app.get<{ Params: PatientParams }>(
    "/api/patients/:patientId",
    async (request) => runtimeOf(request.params).record.summary,
  );

  app.get<{ Params: PatientParams & { id: string } }>(
    "/api/patients/:patientId/documents/:id",
    async (request) => {
      const document = runtimeOf(request.params).record.document(request.params.id);
      if (!document) throw new HttpError(404, `No document ${request.params.id}.`);
      return document;
    },
  );

  app.post<{ Params: PatientParams; Body: { situation: string } }>(
    "/api/patients/:patientId/screens",
    {
      schema: { body: Type.Object({ situation: Type.String({ minLength: 3, maxLength: 4000 }) }) },
    },
    async (request) => runtimeOf(request.params).screen(request.body.situation),
  );

  app.post<{ Params: PatientParams; Body: { situation: string; question: string } }>(
    "/api/patients/:patientId/answers",
    {
      schema: {
        body: Type.Object({
          situation: Type.String({ minLength: 3, maxLength: 4000 }),
          question: Type.String({ minLength: 3, maxLength: 500 }),
        }),
      },
    },
    async (request) => runtimeOf(request.params).ask(request.body.situation, request.body.question),
  );

  app.get<{ Params: PatientParams }>("/api/patients/:patientId/contradictions", async (request) =>
    runtimeOf(request.params).contradictions(),
  );

  app.get<{ Params: PatientParams }>("/api/patients/:patientId/notes", async (request) =>
    runtimeOf(request.params).notes(),
  );

  app.post<{
    Params: PatientParams;
    Body: { topic: string; text: string; source: "patient" | "clinician"; clarifies?: string };
  }>(
    "/api/patients/:patientId/notes",
    {
      schema: {
        body: Type.Object({
          topic: Type.String({ minLength: 1, maxLength: 120 }),
          text: Type.String({ minLength: 1, maxLength: 2000 }),
          source: Type.Union([Type.Literal("patient"), Type.Literal("clinician")]),
          clarifies: Type.Optional(Type.String({ maxLength: 200 })),
        }),
      },
    },
    async (request, reply) => {
      const runtime = runtimeOf(request.params);
      const author = login ? (await login.status()).account : undefined;
      const note = await runtime.addNote({ ...request.body, ...(author ? { author } : {}) });
      return reply.status(201).send(note);
    },
  );

  app.delete<{ Params: PatientParams & { id: string } }>(
    "/api/patients/:patientId/notes/:id",
    async (request, reply) => {
      await runtimeOf(request.params).removeNote(request.params.id);
      return reply.status(204).send();
    },
  );

  if (options.webDist && existsSync(options.webDist)) {
    await app.register(fastifyStatic, { root: options.webDist });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.status(404).send({ error: "Not found." } satisfies ErrorResponse)
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
