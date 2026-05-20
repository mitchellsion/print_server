import type { FastifyInstance } from "fastify";
import { applyPatch, requiresRestart, sanitizeForGui, saveConfig } from "../config/loader.js";
import { ConfigPatchSchema, type Config } from "../config/schema.js";
import type { EnvOverrides } from "../config/loader.js";
import type { EventBus } from "../logging/eventBus.js";

export interface ConfigDeps {
  getConfig: () => Config;
  setConfig: (next: Config) => void;
  overrides: EnvOverrides;
  configFilePath: string;
  bus: EventBus;
}

export async function registerConfigRoutes(
  app: FastifyInstance,
  deps: ConfigDeps,
): Promise<void> {
  app.get("/v1/config", async () => {
    return { config: sanitizeForGui(deps.getConfig(), deps.overrides) };
  });

  app.put("/v1/config", async (req, reply) => {
    const parsed = ConfigPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_patch", details: parsed.error.flatten() };
    }

    const current = deps.getConfig();
    let next: Config;
    try {
      next = applyPatch(current, parsed.data);
    } catch (err) {
      reply.code(400);
      return { error: "merge_failed", message: (err as Error).message };
    }

    try {
      await saveConfig(next, deps.configFilePath);
    } catch (err) {
      reply.code(500);
      return { error: "save_failed", message: (err as Error).message };
    }

    deps.setConfig(next);
    deps.bus.emit("config.changed", { config: next });

    return {
      config: sanitizeForGui(next, deps.overrides),
      requiresRestart: requiresRestart(current, next),
    };
  });
}
