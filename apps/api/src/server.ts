import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = await buildApp(config);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  });

await app.listen({ host: config.host, port: config.port });
