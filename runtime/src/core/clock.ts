import { setTimeout as delay } from "node:timers/promises";

/**
 * Time source for the harness. Wall time is recorded as evidence; monotonic
 * time measures durations within one controller process and is not comparable
 * across processes.
 */
export interface Clock {
  now(): Date;
  monotonicMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, signal ? { signal } : {});
  },
};

/** Byte source for identifiers, injectable so tests are deterministic. */
export type RandomBytes = (size: number) => Uint8Array;
