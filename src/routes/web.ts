import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

function findWebRoot(): string {
  const execDir = dirname(process.execPath);
  const cwd = process.cwd();
  const candidates = [
    resolve(execDir, "web"),
    resolve(execDir, "..", "web"),
    resolve(cwd, "src", "web"),
    resolve(cwd, "web"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[2]!;
}

export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  const webRoot = findWebRoot();

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    index: ["index.html"],
    cacheControl: false,
  });
}
