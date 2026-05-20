import type { FastifyInstance } from "fastify";

export interface HealthDeps {
  startedAt: number;
  version: string;
  certFingerprint?: string | undefined;
}

export async function registerHealthRoute(
  app: FastifyInstance,
  deps: HealthDeps,
): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    version: deps.version,
    uptimeMs: Date.now() - deps.startedAt,
    certFingerprint: deps.certFingerprint,
  }));
}
