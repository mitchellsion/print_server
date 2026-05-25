import { z } from "zod";

const httpSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8443),
});

const corsSchema = z.object({
  origins: z.array(z.string()).default(["*"]),
});

const logSchema = z.object({
  level: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

const tlsSchema = z.object({
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
});

const usbSchema = z.object({
  libusbEnabled: z.boolean().default(true),
  spoolerEnabled: z.boolean().default(true),
  interfaceClassFilter: z.array(z.number().int()).default([7]),
});

const jobsSchema = z.object({
  defaultTimeoutMs: z.number().int().positive().default(30_000),
  historySize: z.number().int().min(0).default(100),
});

const HTTP_DEFAULT = { host: "127.0.0.1", port: 8443 };
const CORS_DEFAULT = { origins: ["*"] };
const LOG_DEFAULT = { level: "info" as const };
const TLS_DEFAULT = {};
const USB_DEFAULT = { libusbEnabled: true, spoolerEnabled: true, interfaceClassFilter: [7] };
const JOBS_DEFAULT = { defaultTimeoutMs: 30_000, historySize: 100 };

export const ConfigSchema = z.object({
  http: httpSchema.default(HTTP_DEFAULT),
  cors: corsSchema.default(CORS_DEFAULT),
  log: logSchema.default(LOG_DEFAULT),
  tls: tlsSchema.default(TLS_DEFAULT),
  usb: usbSchema.default(USB_DEFAULT),
  jobs: jobsSchema.default(JOBS_DEFAULT),
});

export type Config = z.infer<typeof ConfigSchema>;

export const ConfigPatchSchema = z
  .object({
    http: httpSchema.partial().optional(),
    cors: corsSchema.partial().optional(),
    log: logSchema.partial().optional(),
    tls: tlsSchema.partial().optional(),
    usb: usbSchema.partial().optional(),
    jobs: jobsSchema.partial().optional(),
  })
  .partial();

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;
