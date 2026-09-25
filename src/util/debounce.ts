export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let t: NodeJS.Timeout | undefined;
  const d = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...args);
    }, ms);
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return d;
}

/**
 * Runs `fn` at most once per `ms`; a call during the wait guarantees one trailing run.
 * `fn` may be async; a trailing run never overlaps a running one.
 */
export function throttle(fn: () => unknown, ms: number): { (): void; cancel(): void } {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;

  const invoke = async () => {
    timer = undefined;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    last = Date.now();
    try {
      await fn();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, last + ms - Date.now());
    timer = setTimeout(invoke, wait);
  };

  const t = () => (running ? (pending = true) : schedule());
  t.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = false;
  };
  return t;
}
