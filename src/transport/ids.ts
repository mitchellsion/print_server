import { createHash } from "node:crypto";
import type { TransportKind } from "./types.js";

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

export function libusbId(parts: {
  vid: number;
  pid: number;
  serial?: string | undefined;
  portPath?: readonly number[] | undefined;
}): string {
  const identity = parts.serial ?? (parts.portPath ? parts.portPath.join("-") : "unknown");
  return shortHash(`usb-libusb:${parts.vid}:${parts.pid}:${identity}`);
}

export function spoolerId(printerName: string, driver?: string): string {
  return shortHash(`usb-spooler:${printerName}:${driver ?? ""}`);
}

export function transportPrefixedId(kind: TransportKind, hash: string): string {
  return `${kind}:${hash}`;
}
