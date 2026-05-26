import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import "dotenv/config";
import { APP_PATHS } from "./config/paths.js";
import { loadConfig } from "./config/loader.js";
import type { Config } from "./config/schema.js";
import { EventBus } from "./logging/eventBus.js";
import { buildLogger } from "./logging/logger.js";
import { ensureCert, isLoopbackHost } from "./tls/cert.js";
import { isCertTrusted, sha1OfCert, formatFingerprint } from "./tls/trust.js";
import { DeviceRegistry } from "./transport/registry.js";
import { registerDefaultTransports } from "./transport/index.js";
import { JobManager } from "./jobs/queue.js";
import { buildServer } from "./server.js";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const startedAt = Date.now();

  await mkdir(dirname(APP_PATHS.configFile), { recursive: true });
  await mkdir(APP_PATHS.dataDir, { recursive: true });

  const { config: initialConfig, overrides, configFilePath } = await loadConfig();

  const bus = new EventBus();
  let currentConfig: Config = initialConfig;
  const logger = buildLogger(currentConfig, bus);

  bus.on("config.changed", ({ config }) => {
    if (config.log.level !== currentConfig.log.level) {
      logger.level = config.log.level;
    }
    currentConfig = config;
  });

  const certPath = currentConfig.tls.certPath ?? APP_PATHS.certFile;
  const keyPath = currentConfig.tls.keyPath ?? APP_PATHS.keyFile;
  const includeLan = !isLoopbackHost(currentConfig.http.host);
  const cert = await ensureCert({
    certPath,
    keyPath,
    includeLanInterfaces: includeLan,
    extraHostnames: currentConfig.tls.extraHostnames,
    extraIps: currentConfig.tls.extraIps,
  });
  const certSha1 = sha1OfCert(cert.cert);
  logger.info(
    {
      fingerprint: cert.fingerprint,
      certPath,
      keyPath,
      sans: cert.sans,
      regenerated: cert.regenerated,
    },
    "TLS cert ready",
  );
  if (cert.regenerated) {
    logger.warn(
      { sans: cert.sans },
      "TLS cert regenerated with new SANs — existing trust must be re-applied (host + remote devices)",
    );
  }

  const registry = new DeviceRegistry(bus);
  registerDefaultTransports({ registry, config: currentConfig, logger });

  const jobs = new JobManager({
    registry,
    bus,
    logger: logger.child({ component: "jobs" }),
    defaultTimeoutMs: currentConfig.jobs.defaultTimeoutMs,
    historySize: currentConfig.jobs.historySize,
  });

  try {
    await registry.refresh();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "initial device discovery failed");
  }
  registry.startAutoRefresh(5000);

  const app = await buildServer({
    config: currentConfig,
    getConfig: () => currentConfig,
    setConfig: (next) => {
      currentConfig = next;
    },
    overrides,
    configFilePath,
    cert,
    certPath,
    certSha1,
    certSans: cert.sans,
    registry,
    jobs,
    bus,
    logger,
    version: VERSION,
    startedAt,
  });

  const addr = await app.listen({
    host: currentConfig.http.host,
    port: currentConfig.http.port,
  });
  logger.info(
    { addr, fingerprint: cert.fingerprint },
    `listening on ${addr}  cert sha256=${cert.fingerprint}`,
  );

  isCertTrusted(certPath, certSha1)
    .then((trusted) => {
      if (trusted) {
        logger.info({ sha1: formatFingerprint(certSha1) }, "TLS certificate is trusted by this OS");
      } else {
        logger.warn(
          { sha1: formatFingerprint(certSha1), guiUrl: addr },
          "TLS certificate is NOT trusted by this OS — open the GUI and click 'Trust certificate', or run `pnpm trust-cert`",
        );
      }
    })
    .catch((err) => {
      logger.debug({ err: (err as Error).message }, "cert trust check failed");
    });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "fastify close failed");
    }
    try {
      await registry.dispose();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "registry dispose failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
