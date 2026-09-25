import { EventEmitter } from "node:events";
import type { AgentTodo } from "./types.js";

export interface BusEvents {
  "files:changed": { paths: string[] };
  "git:commit": { sha: string; subject: string };
  "tests:finished": { status: string };
  "agent:todos": { todos: AgentTodo[] };
  "tests:run": Record<string, never>;
}

/** Typed event emitter for collector-to-collector signals. */
export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(50);
  }

  on<K extends keyof BusEvents>(name: K, fn: (p: BusEvents[K]) => void): () => void {
    this.ee.on(name, fn);
    return () => this.ee.off(name, fn);
  }

  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    this.ee.emit(name, payload);
  }
}
