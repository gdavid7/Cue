export type HostRuntime = {
  nowMs(): number;
  randomId(): string;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  storagePressure(): boolean | Promise<boolean>;
  /** A number in [0, 1) for retry jitter; Math.random when a host omits it. */
  random?(): number;
};
