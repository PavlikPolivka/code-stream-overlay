let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export const log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn("warn:", ...a),
  error: (...a: unknown[]) => console.error("error:", ...a),
  debug: (...a: unknown[]) => {
    if (verbose) console.error("debug:", ...a);
  },
};
