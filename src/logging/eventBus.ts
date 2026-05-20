import { EventEmitter } from "node:events";
import type { DeviceDescriptor } from "../transport/types.js";
import type { PrintJob } from "../jobs/types.js";
import type { Config } from "../config/schema.js";

export interface LogRecord {
  level: string;
  time: number;
  msg: string;
  [key: string]: unknown;
}

export type EventMap = {
  "device.attached": DeviceDescriptor;
  "device.detached": { id: string };
  "device.refreshed": DeviceDescriptor[];
  "job.queued": { job: PrintJob };
  "job.started": { job: PrintJob };
  "job.finished": { job: PrintJob };
  "job.error": { job: PrintJob };
  log: LogRecord;
  "config.changed": { config: Config };
};

export type EventName = keyof EventMap;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => {
      this.emitter.off(event, listener as (...args: unknown[]) => void);
    };
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }
}
