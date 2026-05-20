import test from "node:test";
import assert from "node:assert/strict";
import { pino } from "pino";
import { EventBus } from "../logging/eventBus.js";
import { DeviceRegistry } from "../transport/registry.js";
import { FakeTransport } from "../transport/fakeTransport.js";
import { JobManager } from "./queue.js";

function silentLogger() {
  return pino({ level: "silent" });
}

test("JobManager submits a job and resolves with done status", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  const transport = new FakeTransport();
  transport.setDevices([{ id: "dev-1" }]);
  registry.registerTransport(transport);
  await registry.refresh();

  const jobs = new JobManager({
    registry,
    bus,
    logger: silentLogger(),
    defaultTimeoutMs: 5000,
    historySize: 10,
  });

  const job = await jobs.submit("dev-1", Buffer.from("hello"));
  assert.equal(job.status, "done");
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.writes[0]?.data.toString("utf8"), "hello");
  assert.equal(transport.closeCount.get("dev-1"), 1);
});

test("DeviceQueue serializes concurrent submissions to the same device", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  const transport = new FakeTransport();
  transport.setDevices([{ id: "dev-1", writeDelayMs: 30 }]);
  registry.registerTransport(transport);
  await registry.refresh();

  const jobs = new JobManager({
    registry,
    bus,
    logger: silentLogger(),
    defaultTimeoutMs: 5000,
    historySize: 100,
  });

  const events: Array<{ id: string; phase: string; at: number }> = [];
  bus.on("job.started", ({ job }) => events.push({ id: job.id, phase: "start", at: Date.now() }));
  bus.on("job.finished", ({ job }) => events.push({ id: job.id, phase: "end", at: Date.now() }));

  const results = await Promise.all([
    jobs.submit("dev-1", Buffer.from("a")),
    jobs.submit("dev-1", Buffer.from("b")),
    jobs.submit("dev-1", Buffer.from("c")),
  ]);

  assert.deepEqual(
    results.map((r) => r.status),
    ["done", "done", "done"],
  );

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    if (a.phase === "start") {
      assert.equal(b.phase, "end", "start must be immediately followed by its own end");
      assert.equal(b.id, a.id, "no other job may start before this one ends");
    }
  }

  assert.equal(transport.writes.length, 3);
  assert.deepEqual(
    transport.writes.map((w) => w.data.toString("utf8")),
    ["a", "b", "c"],
  );
});

test("JobManager reports error status when transport write fails", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  const transport = new FakeTransport();
  transport.setDevices([{ id: "dev-x", failOnWrite: true }]);
  registry.registerTransport(transport);
  await registry.refresh();

  const jobs = new JobManager({
    registry,
    bus,
    logger: silentLogger(),
    defaultTimeoutMs: 5000,
    historySize: 10,
  });

  await assert.rejects(jobs.submit("dev-x", Buffer.from("nope")), /forced write failure/);
  const history = jobs.list("dev-x");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.status, "error");
});
