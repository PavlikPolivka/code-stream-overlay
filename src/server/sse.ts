import type { ServerResponse } from "node:http";
import type { Store } from "../state/store.js";

const PING_MS = 15_000;

export class SseHub {
  private clients = new Set<ServerResponse>();
  private ping: NodeJS.Timeout;
  private unsub: () => void;

  constructor(private store: Store) {
    this.unsub = store.subscribe((e) => {
      if (e.type === "slice") this.broadcast("slice", { key: e.key, value: e.value });
      else this.broadcast("fx", e.fx);
    });
    this.ping = setInterval(() => this.write(": ping\n\n"), PING_MS);
    this.ping.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(frame("snapshot", this.store.get()));
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  close(): void {
    clearInterval(this.ping);
    this.unsub();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private broadcast(event: string, data: unknown) {
    this.write(frame(event, data));
  }

  private write(chunk: string) {
    for (const c of this.clients) c.write(chunk);
  }
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
