import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
};

/** Resolve `rel` under `base`, or undefined if it escapes `base`. */
export function safeJoin(base: string, rel: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const root = path.resolve(base);
  const full = path.resolve(root, "." + path.posix.sep + decoded.replace(/\\/g, "/"));
  return full === root || full.startsWith(root + path.sep) ? full : undefined;
}

export async function sendFile(res: ServerResponse, file: string): Promise<boolean> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  await new Promise<void>((resolve) => {
    const s = createReadStream(file);
    s.on("error", () => {
      res.end();
      resolve();
    });
    s.on("end", resolve);
    s.pipe(res);
  });
  return true;
}
