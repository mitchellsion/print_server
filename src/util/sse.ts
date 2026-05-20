import type { FastifyReply } from "fastify";

export interface SseSink {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

export function openSse(reply: FastifyReply): SseSink {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(":ok\n\n");

  let closed = false;
  reply.raw.on("close", () => {
    closed = true;
  });

  const keepAlive = setInterval(() => {
    if (closed) return;
    reply.raw.write(":\n\n");
  }, 15_000);
  keepAlive.unref?.();

  return {
    send(event, data) {
      if (closed) return;
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
    },
    comment(text) {
      if (closed) return;
      reply.raw.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    },
  };
}
