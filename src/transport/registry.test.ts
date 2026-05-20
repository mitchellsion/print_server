import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../logging/eventBus.js";
import { DeviceRegistry } from "./registry.js";
import { FakeTransport } from "./fakeTransport.js";

test("DeviceRegistry emits attached/detached events on refresh diff", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  const transport = new FakeTransport();
  registry.registerTransport(transport);

  const attached: string[] = [];
  const detached: string[] = [];
  bus.on("device.attached", (d) => attached.push(d.id));
  bus.on("device.detached", ({ id }) => detached.push(id));

  transport.setDevices([{ id: "a" }, { id: "b" }]);
  await registry.refresh();
  assert.deepEqual(attached, ["a", "b"]);

  transport.setDevices([{ id: "b" }, { id: "c" }]);
  await registry.refresh();
  assert.deepEqual(attached, ["a", "b", "c"]);
  assert.deepEqual(detached, ["a"]);
});

test("DeviceRegistry rejects open() for unknown ids", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  await assert.rejects(registry.open("nope"), /Unknown device id/);
});

test("DeviceRegistry routes open() to the transport that discovered the device", async () => {
  const bus = new EventBus();
  const registry = new DeviceRegistry(bus);
  const transport = new FakeTransport();
  transport.setDevices([{ id: "x" }]);
  registry.registerTransport(transport);
  await registry.refresh();

  const handle = await registry.open("x");
  await handle.write(Buffer.from("hi"));
  await handle.close();
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.writes[0]?.data.toString("utf8"), "hi");
});
