import { Writable } from "node:stream";
import pino, { type Logger, multistream } from "pino";
import type { EventBus, LogRecord } from "./eventBus.js";
import type { Config } from "../config/schema.js";

function busStream(bus: EventBus): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        const parsed = JSON.parse(chunk.toString()) as Partial<LogRecord> & {
          level?: number | string;
          time?: number;
          msg?: string;
        };
        const levelLabel =
          typeof parsed.level === "number"
            ? pinoLevelToLabel(parsed.level)
            : (parsed.level ?? "info");
        bus.emit("log", {
          level: levelLabel,
          time: parsed.time ?? Date.now(),
          msg: parsed.msg ?? "",
          ...parsed,
        });
      } catch {
        // ignore parse errors — never let logging break the app
      }
      cb();
    },
  });
}

function pinoLevelToLabel(level: number): string {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  if (level >= 20) return "debug";
  return "trace";
}

export function buildLogger(config: Config, bus: EventBus): Logger {
  const streams = [
    { level: config.log.level, stream: process.stdout },
    { level: config.log.level, stream: busStream(bus) },
  ];
  return pino({ level: config.log.level }, multistream(streams));
}
