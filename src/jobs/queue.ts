import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { EventBus } from "../logging/eventBus.js";
import type { DeviceRegistry } from "../transport/registry.js";
import type { PrintJob, PrintJobError } from "./types.js";

interface QueueDeps {
  registry: DeviceRegistry;
  bus: EventBus;
  logger: Logger;
  defaultTimeoutMs: number;
  historySize: number;
}

interface PendingJob {
  job: PrintJob;
  data: Buffer;
  timeoutMs: number;
  resolve: (job: PrintJob) => void;
  reject: (err: Error) => void;
}

class DeviceQueue {
  private pending: PendingJob[] = [];
  private running = false;

  constructor(
    private readonly deviceId: string,
    private readonly deps: QueueDeps,
    private readonly onComplete: (job: PrintJob) => void,
  ) {}

  size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  enqueue(data: Buffer, timeoutMs: number): Promise<PrintJob> {
    const job: PrintJob = {
      id: randomUUID(),
      deviceId: this.deviceId,
      byteLength: data.byteLength,
      enqueuedAt: Date.now(),
      status: "queued",
    };
    this.deps.bus.emit("job.queued", { job: { ...job } });

    return new Promise<PrintJob>((resolve, reject) => {
      this.pending.push({ job, data, timeoutMs, resolve, reject });
      this.tryRun();
    });
  }

  private tryRun(): void {
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) return;
    this.running = true;
    void this.runOne(next).finally(() => {
      this.running = false;
      this.tryRun();
    });
  }

  private async runOne(pending: PendingJob): Promise<void> {
    const job = pending.job;
    job.status = "running";
    job.startedAt = Date.now();
    this.deps.bus.emit("job.started", { job: { ...job } });

    let handle: { close: () => Promise<void> } | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Print job timed out after ${pending.timeoutMs}ms`));
        }, pending.timeoutMs);

        (async () => {
          const h = await this.deps.registry.open(this.deviceId);
          handle = h;
          await h.write(pending.data);
        })().then(resolve, reject);
      });

      // ensure result is used (no-op)
      void result;

      job.status = "done";
      job.finishedAt = Date.now();
      this.deps.bus.emit("job.finished", { job: { ...job } });
      this.onComplete({ ...job });
      pending.resolve({ ...job });
    } catch (err) {
      const e = err as Error & { code?: string };
      const error: PrintJobError = { message: e.message };
      if (e.code) error.code = e.code;
      job.status = "error";
      job.finishedAt = Date.now();
      job.error = error;
      this.deps.bus.emit("job.error", { job: { ...job } });
      this.onComplete({ ...job });
      this.deps.logger.warn(
        { jobId: job.id, deviceId: job.deviceId, err: e.message },
        "print job failed",
      );
      pending.reject(e);
    } finally {
      if (timer) clearTimeout(timer);
      if (handle) {
        try {
          await handle.close();
        } catch (closeErr) {
          this.deps.logger.debug(
            { err: (closeErr as Error).message },
            "device handle close failed",
          );
        }
      }
    }
  }
}

export class JobManager {
  private queues = new Map<string, DeviceQueue>();
  private history: PrintJob[] = [];

  constructor(private readonly deps: QueueDeps) {}

  private queueFor(deviceId: string): DeviceQueue {
    let q = this.queues.get(deviceId);
    if (!q) {
      q = new DeviceQueue(deviceId, this.deps, (job) => this.pushHistory(job));
      this.queues.set(deviceId, q);
    }
    return q;
  }

  submit(deviceId: string, data: Buffer, timeoutMs?: number): Promise<PrintJob> {
    const t = timeoutMs ?? this.deps.defaultTimeoutMs;
    return this.queueFor(deviceId).enqueue(data, t);
  }

  list(deviceId?: string): PrintJob[] {
    if (!deviceId) return [...this.history];
    return this.history.filter((j) => j.deviceId === deviceId);
  }

  get(jobId: string): PrintJob | undefined {
    return this.history.find((j) => j.id === jobId);
  }

  queueSize(deviceId: string): number {
    return this.queues.get(deviceId)?.size() ?? 0;
  }

  private pushHistory(job: PrintJob): void {
    this.history.push(job);
    const max = this.deps.historySize;
    if (this.history.length > max) {
      this.history.splice(0, this.history.length - max);
    }
  }
}
