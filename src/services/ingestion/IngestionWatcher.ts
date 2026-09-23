export interface IngestionWatcher {
  name: string;
  start(): void;
  stop(): void;
}
