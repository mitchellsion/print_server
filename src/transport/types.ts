export type TransportKind = "usb-libusb" | "usb-spooler" | "bluetooth" | "serial";

export interface DeviceVendor {
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
  serial?: string;
}

export interface DeviceCapabilities {
  rawWrite: boolean;
  bidirectional: boolean;
}

export interface DeviceDescriptor {
  id: string;
  kind: TransportKind;
  label: string;
  vendor?: DeviceVendor;
  spoolerName?: string;
  capabilities?: DeviceCapabilities;
}

export interface DeviceHandle {
  readonly descriptor: DeviceDescriptor;
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface Transport {
  readonly kind: TransportKind;
  discover(): Promise<DeviceDescriptor[]>;
  open(id: string): Promise<DeviceHandle>;
  onChange?(listener: () => void): () => void;
  dispose?(): Promise<void>;
}
