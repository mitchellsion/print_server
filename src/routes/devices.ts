import type { FastifyInstance } from "fastify";
import type { DeviceRegistry } from "../transport/registry.js";
import type { JobManager } from "../jobs/queue.js";

interface DeviceParams {
  id: string;
}

export interface DevicesDeps {
  registry: DeviceRegistry;
  jobs: JobManager;
}

export async function registerDeviceRoutes(
  app: FastifyInstance,
  deps: DevicesDeps,
): Promise<void> {
  app.get("/v1/devices", async () => {
    return {
      devices: deps.registry.list().map((d) => ({
        ...d,
        queueSize: deps.jobs.queueSize(d.id),
      })),
    };
  });

  app.get<{ Params: DeviceParams }>("/v1/devices/:id", async (req, reply) => {
    const descriptor = deps.registry.get(req.params.id);
    if (!descriptor) {
      reply.code(404);
      return { error: "device_not_found", deviceId: req.params.id };
    }
    return {
      device: descriptor,
      queueSize: deps.jobs.queueSize(descriptor.id),
      recentJobs: deps.jobs.list(descriptor.id).slice(-20),
    };
  });

  app.post("/v1/devices/refresh", async () => {
    const devices = await deps.registry.refresh();
    return { devices };
  });
}
