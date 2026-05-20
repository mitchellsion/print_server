import { createRequire } from "node:module";
import { join } from "node:path";
import type * as UsbTypes from "usb";
import type { Logger } from "pino";
import { libusbId } from "./ids.js";
import type {
  DeviceDescriptor,
  DeviceHandle,
  Transport,
} from "./types.js";

type Device = UsbTypes.Device;
type Interface = UsbTypes.Interface;
type OutEndpoint = UsbTypes.OutEndpoint;

function loadUsbModule(): typeof UsbTypes {
  const anchors = [
    process.execPath,
    join(process.cwd(), "package.json"),
  ];
  let lastErr: unknown;
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("usb") as typeof UsbTypes;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Failed to load 'usb' native module: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

const usbModule = loadUsbModule();
const { getDeviceList, usb, OutEndpoint: OutEndpointCtor } = usbModule;

interface LibusbTransportOptions {
  interfaceClassFilter: readonly number[];
  logger: Logger;
}

interface ResolvedDevice {
  descriptor: DeviceDescriptor;
  device: Device;
  interfaceNumber: number;
}

async function readStringDescriptor(device: Device, index: number): Promise<string | undefined> {
  if (!index) return undefined;
  return new Promise((resolve) => {
    try {
      device.getStringDescriptor(index, (err, value) => {
        if (err || !value) resolve(undefined);
        else resolve(value);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function findPrinterInterface(
  device: Device,
  classFilter: readonly number[],
): number | undefined {
  const interfaces = device.interfaces ?? [];
  for (const iface of interfaces) {
    const cls = iface.descriptor.bInterfaceClass;
    if (classFilter.includes(cls)) return iface.interfaceNumber;
  }
  // Fall back to device-level class match (some printers report class at device level)
  const deviceClass = device.deviceDescriptor.bDeviceClass;
  if (classFilter.includes(deviceClass) && interfaces.length > 0) {
    const first = interfaces[0];
    if (first) return first.interfaceNumber;
  }
  return undefined;
}

function findBulkOutEndpoint(iface: Interface): OutEndpoint | undefined {
  for (const ep of iface.endpoints) {
    if (
      ep.direction === "out" &&
      ep.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK &&
      ep instanceof OutEndpointCtor
    ) {
      return ep;
    }
  }
  return undefined;
}

async function describeDevice(
  device: Device,
  classFilter: readonly number[],
  logger: Logger,
): Promise<ResolvedDevice | undefined> {
  const { idVendor: vid, idProduct: pid } = device.deviceDescriptor;

  let opened = false;
  try {
    device.open();
    opened = true;
  } catch (err) {
    // Could not open — emit a descriptor with vid/pid only if interface class is printer at device level
    const guessClass = device.deviceDescriptor.bDeviceClass;
    if (!classFilter.includes(guessClass)) return undefined;
    logger.debug(
      { vid, pid, err: (err as Error).message },
      "libusb: open failed, returning vid/pid-only descriptor",
    );
    const id = libusbId({
      vid,
      pid,
      portPath: device.portNumbers,
    });
    return {
      descriptor: {
        id,
        kind: "usb-libusb",
        label: `USB ${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`,
        vendor: { vid, pid },
        capabilities: { rawWrite: false, bidirectional: false },
      },
      device,
      interfaceNumber: -1,
    };
  }

  try {
    const interfaceNumber = findPrinterInterface(device, classFilter);
    if (interfaceNumber === undefined) return undefined;

    const manufacturer = await readStringDescriptor(
      device,
      device.deviceDescriptor.iManufacturer,
    );
    const product = await readStringDescriptor(device, device.deviceDescriptor.iProduct);
    const serial = await readStringDescriptor(device, device.deviceDescriptor.iSerialNumber);

    const id = libusbId({ vid, pid, serial, portPath: device.portNumbers });
    const label = product
      ? `${product}${manufacturer ? ` (${manufacturer})` : ""}`
      : `USB ${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;

    return {
      descriptor: {
        id,
        kind: "usb-libusb",
        label,
        vendor: {
          vid,
          pid,
          ...(manufacturer ? { manufacturer } : {}),
          ...(product ? { product } : {}),
          ...(serial ? { serial } : {}),
        },
        capabilities: { rawWrite: true, bidirectional: false },
      },
      device,
      interfaceNumber,
    };
  } finally {
    if (opened) {
      try {
        device.close();
      } catch {
        // ignore
      }
    }
  }
}

export class UsbLibusbTransport implements Transport {
  readonly kind = "usb-libusb" as const;
  private resolved = new Map<string, ResolvedDevice>();
  private changeListeners = new Set<() => void>();
  private attachHandler: ((device: Device) => void) | undefined = undefined;
  private detachHandler: ((device: Device) => void) | undefined = undefined;

  constructor(private readonly options: LibusbTransportOptions) {}

  async discover(): Promise<DeviceDescriptor[]> {
    this.resolved.clear();
    const devices = getDeviceList();
    const results: DeviceDescriptor[] = [];
    for (const dev of devices) {
      const resolved = await describeDevice(
        dev,
        this.options.interfaceClassFilter,
        this.options.logger,
      );
      if (resolved) {
        this.resolved.set(resolved.descriptor.id, resolved);
        results.push(resolved.descriptor);
      }
    }
    return results;
  }

  async open(id: string): Promise<DeviceHandle> {
    const resolved = this.resolved.get(id);
    if (!resolved) throw new Error(`libusb device not found: ${id}`);
    if (resolved.interfaceNumber < 0) {
      throw new Error(
        `libusb device ${id} could not be opened during discovery (likely a permission or driver issue)`,
      );
    }

    const { device, interfaceNumber } = resolved;
    device.open();

    try {
      const iface = device.interface(interfaceNumber);
      if (!iface) throw new Error(`Interface ${interfaceNumber} not found`);

      // Detach kernel driver on Linux/macOS if it claims the interface
      try {
        if (typeof iface.isKernelDriverActive === "function" && iface.isKernelDriverActive()) {
          iface.detachKernelDriver();
        }
      } catch (err) {
        this.options.logger.debug({ err: (err as Error).message }, "detachKernelDriver failed (may be benign)");
      }

      iface.claim();

      const endpoint = findBulkOutEndpoint(iface);
      if (!endpoint) {
        try {
          await iface.releaseAsync();
        } catch {
          // ignore
        }
        device.close();
        throw new Error(`No bulk OUT endpoint found on interface ${interfaceNumber}`);
      }

      const descriptor = resolved.descriptor;
      let closed = false;

      return {
        descriptor,
        async write(data) {
          if (closed) throw new Error("Device handle is closed");
          await endpoint.transferAsync(data);
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await iface.releaseAsync();
          } catch {
            // ignore
          }
          try {
            device.close();
          } catch {
            // ignore
          }
        },
      };
    } catch (err) {
      try {
        device.close();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  onChange(listener: () => void): () => void {
    if (!this.attachHandler) {
      this.attachHandler = () => {
        for (const fn of this.changeListeners) fn();
      };
      this.detachHandler = () => {
        for (const fn of this.changeListeners) fn();
      };
      usb.on("attach", this.attachHandler);
      usb.on("detach", this.detachHandler);
    }
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
      if (this.changeListeners.size === 0 && this.attachHandler && this.detachHandler) {
        usb.off("attach", this.attachHandler);
        usb.off("detach", this.detachHandler);
        this.attachHandler = undefined;
        this.detachHandler = undefined;
      }
    };
  }

  async dispose(): Promise<void> {
    if (this.attachHandler) usb.off("attach", this.attachHandler);
    if (this.detachHandler) usb.off("detach", this.detachHandler);
    this.attachHandler = undefined;
    this.detachHandler = undefined;
    this.changeListeners.clear();
    this.resolved.clear();
  }
}
