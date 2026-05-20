import type {
  DeviceDescriptor,
  DeviceHandle,
  Transport,
} from "./types.js";

export interface FakeDeviceSpec {
  id: string;
  label?: string;
  failOnWrite?: boolean;
  writeDelayMs?: number;
}

export class FakeTransport implements Transport {
  readonly kind = "usb-libusb" as const;
  readonly writes: Array<{ id: string; data: Buffer; at: number }> = [];
  readonly openCount = new Map<string, number>();
  readonly closeCount = new Map<string, number>();
  private devices: FakeDeviceSpec[] = [];
  private changeListeners = new Set<() => void>();

  setDevices(devices: FakeDeviceSpec[]): void {
    this.devices = devices;
    for (const fn of this.changeListeners) fn();
  }

  async discover(): Promise<DeviceDescriptor[]> {
    return this.devices.map((d) => ({
      id: d.id,
      kind: "usb-libusb",
      label: d.label ?? d.id,
      capabilities: { rawWrite: true, bidirectional: false },
    }));
  }

  async open(id: string): Promise<DeviceHandle> {
    const spec = this.devices.find((d) => d.id === id);
    if (!spec) throw new Error(`Fake device not found: ${id}`);
    this.openCount.set(id, (this.openCount.get(id) ?? 0) + 1);
    const writes = this.writes;
    const closeCount = this.closeCount;
    return {
      descriptor: {
        id: spec.id,
        kind: "usb-libusb",
        label: spec.label ?? spec.id,
        capabilities: { rawWrite: true, bidirectional: false },
      },
      async write(data) {
        if (spec.writeDelayMs) await new Promise((r) => setTimeout(r, spec.writeDelayMs));
        if (spec.failOnWrite) throw new Error("forced write failure");
        writes.push({ id: spec.id, data: Buffer.from(data), at: Date.now() });
      },
      async close() {
        closeCount.set(id, (closeCount.get(id) ?? 0) + 1);
      },
    };
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
}
