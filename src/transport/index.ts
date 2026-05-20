import type { Logger } from "pino";
import type { Config } from "../config/schema.js";
import type { DeviceRegistry } from "./registry.js";
import { UsbLibusbTransport } from "./usbLibusb.js";
import { UsbSpoolerTransport } from "./usbSpooler.js";

export interface RegisterTransportsOptions {
  registry: DeviceRegistry;
  config: Config;
  logger: Logger;
}

export function registerDefaultTransports(opts: RegisterTransportsOptions): void {
  const { registry, config, logger } = opts;

  if (config.usb.libusbEnabled) {
    registry.registerTransport(
      new UsbLibusbTransport({
        interfaceClassFilter: config.usb.interfaceClassFilter,
        logger: logger.child({ transport: "usb-libusb" }),
      }),
    );
  }

  if (config.usb.spoolerEnabled) {
    registry.registerTransport(
      new UsbSpoolerTransport({ logger: logger.child({ transport: "usb-spooler" }) }),
    );
  }
}
