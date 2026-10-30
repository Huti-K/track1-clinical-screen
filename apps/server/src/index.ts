import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openConfigured } from "./open.js";

const { runtimes, login } = await openConfigured((message, error) =>
  console.warn(message, error ?? ""),
);
const app = await buildApp(runtimes, { login, webDist: config.webDist, logger: true });

if (await login.signedIn())
  for (const runtime of runtimes)
    runtime.prepare((message, error) =>
      app.log.error({ err: error, patient: runtime.record.summary.id }, message),
    );

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    login.cancel();
    await app.close();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    process.exit(0);
  });

await app.listen({ port: config.port, host: config.host });
console.log(
  `Patients ${runtimes.map((runtime) => runtime.record.summary.name).join(", ")}; model ${runtimes[0]?.modelName}`,
);
