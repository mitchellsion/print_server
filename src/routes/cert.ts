import type { FastifyInstance } from "fastify";
import {
  installCertTrust,
  isCertTrusted,
  uninstallCertTrust,
} from "../tls/trust.js";

export interface CertDeps {
  certPath: string;
  certPem: string;
  sha1: string;
  sha256: string;
  sans: { dns: string[]; ip: string[] };
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
      sans: deps.sans,
      trusted,
      platform: process.platform,
      downloads: {
        pem: "/v1/cert.pem",
        crt: "/v1/cert.crt",
      },
    };
  });

  app.get("/v1/cert.pem", async (_req, reply) => {
    reply
      .header("content-type", "application/x-pem-file")
      .header("content-disposition", 'attachment; filename="print-server.pem"');
    return deps.certPem;
  });

  app.get("/v1/cert.crt", async (_req, reply) => {
    reply
      .header("content-type", "application/x-x509-ca-cert")
      .header("content-disposition", 'attachment; filename="print-server.crt"');
    return deps.certPem;
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
