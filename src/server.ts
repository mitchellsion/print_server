import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import type { Logger } from "pino";
import type { Config } from "./config/schema.js";
import type { EnvOverrides } from "./config/loader.js";
import type { EventBus } from "./logging/eventBus.js";
import type { DeviceRegistry } from "./transport/registry.js";
import type { JobManager } from "./jobs/queue.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerPrintRoutes } from "./routes/print.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerEventsRoute } from "./routes/events.js";
import { registerCertRoutes } from "./routes/cert.js";
import { registerWebRoutes } from "./routes/web.js";

export interface BuildServerDeps {
  config: Config;
  getConfig: () => Config;
  setConfig: (next: Config) => void;
  overrides: EnvOverrides;
  configFilePath: string;
  cert: { cert: string; key: string; fingerprint: string };
  certPath: string;
  certSha1: string;
  certSans: { dns: string[]; ip: string[] };
  registry: DeviceRegistry;
  jobs: JobManager;
  bus: EventBus;
  logger: Logger;
  version: string;
  startedAt: number;
}

export async function buildServer(deps: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    https: { cert: deps.cert.cert, key: deps.cert.key },
    logger: { level: deps.config.log.level },
    disableRequestLogging: false,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      const allow = deps.getConfig().cors.origins;
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allow.includes("*") || allow.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });

  await registerHealthRoute(app, {
    startedAt: deps.startedAt,
    version: deps.version,
    certFingerprint: deps.cert.fingerprint,
  });
  await registerDeviceRoutes(app, { registry: deps.registry, jobs: deps.jobs });
  await registerPrintRoutes(app, { registry: deps.registry, jobs: deps.jobs });
  await registerConfigRoutes(app, {
    getConfig: deps.getConfig,
    setConfig: deps.setConfig,
    overrides: deps.overrides,
    configFilePath: deps.configFilePath,
    bus: deps.bus,
  });
  await registerEventsRoute(app, { bus: deps.bus });
  await registerCertRoutes(app, {
    certPath: deps.certPath,
    certPem: deps.cert.cert,
    sha1: deps.certSha1,
    sha256: deps.cert.fingerprint,
    sans: deps.certSans,
  });
  await registerWebRoutes(app);

  return app;
}
