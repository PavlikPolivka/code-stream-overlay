import { isDeepStrictEqual } from "node:util";
import type { Fx, FxName, SliceKey, State } from "./types.js";

export type StoreEvent =
  | { type: "slice"; key: SliceKey; value: State[SliceKey] }
  | { type: "fx"; fx: Fx };

export class Store {
  private state: State;
  private subs = new Set<(e: StoreEvent) => void>();

  constructor(initial: State) {
    this.state = initial;
  }

  get(): State;
  get<K extends SliceKey>(key: K): State[K];
  get<K extends SliceKey>(key?: K) {
    return key ? this.state[key] : this.state;
  }

  /** Replace a slice. Returns false (and broadcasts nothing) when the value is unchanged. */
  set<K extends SliceKey>(key: K, value: State[K]): boolean {
    if (isDeepStrictEqual(this.state[key], value)) return false;
    this.state = { ...this.state, [key]: value };
    this.emit({ type: "slice", key, value });
    return true;
  }

  update<K extends SliceKey>(key: K, fn: (prev: State[K]) => State[K]): boolean {
    return this.set(key, fn(this.state[key]));
  }

  fx(name: FxName, payload?: Record<string, unknown>): void {
    this.emit({ type: "fx", fx: payload ? { name, payload } : { name } });
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break writers */
      }
    }
  }
}
