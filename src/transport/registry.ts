import type { EventBus } from "../logging/eventBus.js";
import type { DeviceDescriptor, DeviceHandle, Transport } from "./types.js";

const PREFER_ORDER: Record<DeviceDescriptor["kind"], number> = {
  "usb-libusb": 0,
  serial: 1,
  bluetooth: 2,
  "usb-spooler": 3,
};

function dedupKey(d: DeviceDescriptor): string {
  const v = d.vendor;
  if (v?.vid !== undefined && v.pid !== undefined && v.serial) {
    return `vps:${v.vid}:${v.pid}:${v.serial}`;
  }
  return `id:${d.id}`;
}

export class DeviceRegistry {
  private readonly transports: Transport[] = [];
  private readonly transportUnsubs: Array<() => void> = [];
  private devices = new Map<string, { descriptor: DeviceDescriptor; transport: Transport }>();
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly bus: EventBus) {}

  registerTransport(transport: Transport): void {
    this.transports.push(transport);
    if (transport.onChange) {
      const unsub = transport.onChange(() => {
        void this.refresh().catch(() => {
          // refresh errors should not crash; the next interval will retry
        });
      });
      this.transportUnsubs.push(unsub);
    }
  }

  startAutoRefresh(intervalMs = 5000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  async refresh(): Promise<DeviceDescriptor[]> {
    const results = await Promise.all(
      this.transports.map(async (t) => {
        try {
          const descriptors = await t.discover();
          return descriptors.map((d) => ({ d, t }));
        } catch {
          return [];
        }
      }),
    );
    const flat = results.flat();

    const byDedup = new Map<string, { descriptor: DeviceDescriptor; transport: Transport }>();
    for (const { d, t } of flat) {
      const key = dedupKey(d);
      const existing = byDedup.get(key);
      if (!existing) {
        byDedup.set(key, { descriptor: d, transport: t });
        continue;
      }
      const incomingRank = PREFER_ORDER[d.kind];
      const existingRank = PREFER_ORDER[existing.descriptor.kind];
      if (incomingRank < existingRank) {
        byDedup.set(key, { descriptor: d, transport: t });
      }
    }

    const previousIds = new Set(this.devices.keys());
    const next = new Map<string, { descriptor: DeviceDescriptor; transport: Transport }>();
    for (const entry of byDedup.values()) {
      next.set(entry.descriptor.id, entry);
    }

    for (const [id, entry] of next.entries()) {
      if (!previousIds.has(id)) {
        this.bus.emit("device.attached", entry.descriptor);
      }
      previousIds.delete(id);
    }
    for (const removedId of previousIds) {
      this.bus.emit("device.detached", { id: removedId });
    }

    this.devices = next;
    const list = this.list();
    this.bus.emit("device.refreshed", list);
    return list;
  }

  list(): DeviceDescriptor[] {
    return [...this.devices.values()].map((e) => e.descriptor);
  }

  get(id: string): DeviceDescriptor | undefined {
    return this.devices.get(id)?.descriptor;
  }

  async open(id: string): Promise<DeviceHandle> {
    const entry = this.devices.get(id);
    if (!entry) throw new Error(`Unknown device id: ${id}`);
    return entry.transport.open(id);
  }

  async dispose(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const unsub of this.transportUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    await Promise.all(
      this.transports.map(async (t) => {
        try {
          await t.dispose?.();
        } catch {
          // ignore
        }
      }),
    );
  }
}
