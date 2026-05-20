import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigSchema, type Config, type ConfigPatch } from "./schema.js";
import { APP_PATHS } from "./paths.js";

const ENV_KEYS = {
  port: "PRINT_SERVER_PORT",
  host: "PRINT_SERVER_HOST",
  logLevel: "PRINT_SERVER_LOG_LEVEL",
  configFile: "PRINT_SERVER_CONFIG",
} as const;

export type EnvOverrides = {
  http: { host: boolean; port: boolean };
  log: { level: boolean };
};

function readEnvOverrides(): {
  patch: ConfigPatch;
  overrides: EnvOverrides;
} {
  const patch: ConfigPatch = {};
  const overrides: EnvOverrides = {
    http: { host: false, port: false },
    log: { level: false },
  };
  const port = process.env[ENV_KEYS.port];
  const host = process.env[ENV_KEYS.host];
  const level = process.env[ENV_KEYS.logLevel];

  if (port || host) {
    patch.http = {};
    if (port) {
      const n = Number.parseInt(port, 10);
      if (!Number.isFinite(n)) throw new Error(`Invalid ${ENV_KEYS.port}: ${port}`);
      patch.http.port = n;
      overrides.http.port = true;
    }
    if (host) {
      patch.http.host = host;
      overrides.http.host = true;
    }
  }
  if (level) {
    patch.log = { level: level as Config["log"]["level"] };
    overrides.log.level = true;
  }
  return { patch, overrides };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== "object" || base === null) return patch as T;
  if (Array.isArray(base)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge(out[k] as never, v);
  }
  return out as T;
}

export type ConfigBundle = {
  config: Config;
  overrides: EnvOverrides;
  configFilePath: string;
};

export async function loadConfig(): Promise<ConfigBundle> {
  const configFilePath = process.env[ENV_KEYS.configFile] ?? APP_PATHS.configFile;

  let onDisk: unknown = {};
  try {
    const raw = await readFile(configFilePath, "utf8");
    onDisk = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const { patch: envPatch, overrides } = readEnvOverrides();
  const merged = deepMerge(onDisk as object, envPatch);
  const config = ConfigSchema.parse(merged);
  return { config, overrides, configFilePath };
}

export async function saveConfig(
  next: Config,
  configFilePath = APP_PATHS.configFile,
): Promise<void> {
  await mkdir(dirname(configFilePath), { recursive: true });
  const tmp = `${configFilePath}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, configFilePath);
}

export function applyPatch(current: Config, patch: ConfigPatch): Config {
  const merged = deepMerge(current, patch);
  return ConfigSchema.parse(merged);
}

export function sanitizeForGui(
  config: Config,
  overrides: EnvOverrides,
): Config & { __readonly: string[] } {
  const readonly: string[] = [];
  if (overrides.http.host) readonly.push("http.host");
  if (overrides.http.port) readonly.push("http.port");
  if (overrides.log.level) readonly.push("log.level");
  return { ...config, __readonly: readonly };
}

const RESTART_REQUIRED_KEYS = new Set([
  "http.host",
  "http.port",
  "tls.certPath",
  "tls.keyPath",
  "usb.libusbEnabled",
  "usb.spoolerEnabled",
]);

export function requiresRestart(prev: Config, next: Config): boolean {
  const get = (cfg: Config, path: string): unknown => {
    return path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, cfg);
  };
  for (const key of RESTART_REQUIRED_KEYS) {
    if (JSON.stringify(get(prev, key)) !== JSON.stringify(get(next, key))) return true;
  }
  return false;
}
