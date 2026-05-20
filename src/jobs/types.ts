export type JobStatus = "queued" | "running" | "done" | "error";

export interface PrintJobError {
  message: string;
  code?: string;
}

export interface PrintJob {
  id: string;
  deviceId: string;
  byteLength: number;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: JobStatus;
  error?: PrintJobError;
}
