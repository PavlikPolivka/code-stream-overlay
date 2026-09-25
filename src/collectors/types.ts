export interface Collector {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
