import type { Clock } from "../../src/core/clock.ts";

/** Manually advanced clock; `sleep` advances time instead of waiting. */
export class FakeClock implements Clock {
  #wall: number;
  #monotonic = 0;

  constructor(start = "2026-09-25T16:14:49.000Z") {
    this.#wall = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#wall);
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  advance(ms: number): void {
    this.#wall += ms;
    this.#monotonic += ms;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.advance(ms);
    return Promise.resolve();
  }
}
