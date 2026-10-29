import { existsSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import fastifyStatic from "@fastify/static";
import type { ErrorResponse } from "@track1/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type ClinicalRuntime, HttpError } from "./agent/runtime.js";
import type { SubscriptionLogin } from "./auth/login.js";

export async function buildApp(
  runtime: ClinicalRuntime,
  options: {
    /** Without it every route is open, as in tests whose model needs no sign-in. */
    login?: SubscriptionLogin;
    webDist?: string;
    logger?: FastifyServerOptions["logger"];
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const { login } = options;

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

  app.get("/api/patient", async () => runtime.record.summary);

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request) => {
    const document = runtime.record.document(request.params.id);
    if (!document) throw new HttpError(404, `No document ${request.params.id}.`);
    return document;
  });

  app.post<{ Body: { situation: string } }>(
    "/api/screens",
    {
      schema: { body: Type.Object({ situation: Type.String({ minLength: 3, maxLength: 4000 }) }) },
    },
    async (request) => runtime.screen(request.body.situation),
  );

  app.get("/api/contradictions", async () => runtime.contradictions());

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
