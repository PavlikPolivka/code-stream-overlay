import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const newToken = () => randomBytes(32).toString("base64url");

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requestToken(req: IncomingMessage, url: URL): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token") ?? undefined;
}

/** DNS-rebinding guard: the Host header must name us. */
export function hostAllowed(hostHeader: string | undefined, bindHost: string, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${bindHost}:${port}`]);
  return allowed.has(hostHeader.toLowerCase());
}
