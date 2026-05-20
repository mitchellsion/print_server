import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JobManager } from "../jobs/queue.js";
import type { DeviceRegistry } from "../transport/registry.js";
import { decodePayload } from "../util/decodePayload.js";

const PrintBody = z.object({
  deviceId: z.string().min(1),
  data: z.string().min(1),
  encoding: z.enum(["base64", "hex", "utf8"]).default("base64"),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

interface JobParams {
  jobId: string;
}

export interface PrintDeps {
  registry: DeviceRegistry;
  jobs: JobManager;
}

export async function registerPrintRoutes(
  app: FastifyInstance,
  deps: PrintDeps,
): Promise<void> {
  app.post("/v1/print", async (req, reply) => {
    const parsed = PrintBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_body", details: parsed.error.flatten() };
    }
    const { deviceId, data, encoding, timeoutMs } = parsed.data;

    if (!deps.registry.get(deviceId)) {
      reply.code(404);
      return { error: "device_not_found", deviceId };
    }

    let bytes: Buffer;
    try {
      bytes = decodePayload(data, encoding);
    } catch (err) {
      reply.code(400);
      return { error: "decode_failed", message: (err as Error).message };
    }
    if (bytes.byteLength === 0) {
      reply.code(400);
      return { error: "empty_payload" };
    }

    try {
      const job = await deps.jobs.submit(deviceId, bytes, timeoutMs);
      return {
        jobId: job.id,
        status: job.status,
        durationMs:
          job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : undefined,
      };
    } catch (err) {
      reply.code(502);
      return {
        error: "print_failed",
        message: (err as Error).message,
      };
    }
  });

  app.get<{ Params: JobParams }>("/v1/jobs/:jobId", async (req, reply) => {
    const job = deps.jobs.get(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "job_not_found", jobId: req.params.jobId };
    }
    return { job };
  });
}
