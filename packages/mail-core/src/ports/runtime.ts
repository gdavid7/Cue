export type HostRuntime = {
  nowMs(): number;
  randomId(): string;
  /** A number in [0, 1), for jitter. */
  random(): number;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  storagePressure(): boolean | Promise<boolean>;
};
