import envPaths from "env-paths";
import { join } from "node:path";

const paths = envPaths("print-server", { suffix: "" });

export const APP_PATHS = {
  configDir: paths.config,
  dataDir: paths.data,
  logDir: paths.log,
  configFile: join(paths.config, "config.json"),
  certFile: join(paths.data, "tls", "cert.pem"),
  keyFile: join(paths.data, "tls", "key.pem"),
} as const;
