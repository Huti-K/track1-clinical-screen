import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openConfigured } from "./open.js";

const { runtime, login } = await openConfigured((message, error) =>
  console.warn(message, error ?? ""),
);
const app = await buildApp(runtime, { login, webDist: config.webDist, logger: true });

if (await login.signedIn())
  runtime.prepare((message, error) => app.log.error({ err: error }, message));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    login.cancel();
    await app.close();
    await runtime.close();
    process.exit(0);
  });

await app.listen({ port: config.port, host: config.host });
console.log(`Patient ${runtime.record.summary.name}, model ${runtime.modelName}`);
