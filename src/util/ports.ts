import type { Server } from "node:http";

/** Listen on `port`, or the next free one among `attempts` ports. Port 0 = any free port. */
export async function listenWithFallback(server: Server, host: string, port: number, attempts: number): Promise<number> {
  for (let i = 0; i <= (port === 0 ? 0 : attempts); i++) {
    const p = port === 0 ? 0 : port + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => {
          server.off("listening", onOk);
          reject(e);
        };
        const onOk = () => {
          server.off("error", onErr);
          resolve();
        };
        server.once("error", onErr);
        server.once("listening", onOk);
        server.listen(p, host);
      });
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`no free port in ${port}-${port + attempts}`);
}
