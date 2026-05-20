import type { FastifyInstance } from "fastify";
import {
  installCertTrust,
  isCertTrusted,
  uninstallCertTrust,
} from "../tls/trust.js";

export interface CertDeps {
  certPath: string;
  sha1: string;
  sha256: string;
}

export async function registerCertRoutes(
  app: FastifyInstance,
  deps: CertDeps,
): Promise<void> {
  app.get("/v1/cert", async () => {
    const trusted = await isCertTrusted(deps.certPath, deps.sha1).catch(() => false);
    return {
      certPath: deps.certPath,
      sha1: deps.sha1,
      sha256: deps.sha256,
      trusted,
      platform: process.platform,
    };
  });

  app.post("/v1/cert/trust", async (_req, reply) => {
    try {
      await installCertTrust(deps.certPath, deps.sha1);
      const trusted = await isCertTrusted(deps.certPath, deps.sha1).catch(() => false);
      return { ok: true, trusted };
    } catch (err) {
      const msg = (err as Error).message;
      reply.code(msg === "declined by user" ? 409 : 500);
      return { ok: false, error: msg };
    }
  });

  app.delete("/v1/cert/trust", async (_req, reply) => {
    try {
      await uninstallCertTrust(deps.certPath, deps.sha1);
      const trusted = await isCertTrusted(deps.certPath, deps.sha1).catch(() => false);
      return { ok: true, trusted };
    } catch (err) {
      const msg = (err as Error).message;
      reply.code(msg === "declined by user" ? 409 : 500);
      return { ok: false, error: msg };
    }
  });
}
