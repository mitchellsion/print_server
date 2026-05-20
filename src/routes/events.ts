import type { FastifyInstance } from "fastify";
import type { EventBus, EventName } from "../logging/eventBus.js";
import { openSse } from "../util/sse.js";

export interface EventsDeps {
  bus: EventBus;
}

const STREAMED_EVENTS: EventName[] = [
  "device.attached",
  "device.detached",
  "device.refreshed",
  "job.queued",
  "job.started",
  "job.finished",
  "job.error",
  "log",
  "config.changed",
];

export async function registerEventsRoute(
  app: FastifyInstance,
  deps: EventsDeps,
): Promise<void> {
  app.get("/v1/events", async (req, reply) => {
    const sink = openSse(reply);
    sink.send("hello", { time: Date.now() });

    const unsubs = STREAMED_EVENTS.map((name) =>
      deps.bus.on(name, (payload) => {
        sink.send(name, payload);
      }),
    );

    req.raw.on("close", () => {
      for (const u of unsubs) u();
      sink.close();
    });
  });
}
