// Serializes calls and spaces them at least `minIntervalMs` apart, so a burst of
// requests can't exceed the upstream's per-call pacing.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time and the spacing bookkeeping stays consistent. In-flight network time still
// overlaps because acquire() resolves before the request itself runs.
//
// Timed with the monotonic performance.now(), not Date.now(): a wall clock
// stepped back (NTP, a restored VM) would otherwise turn the spacing into a
// wait as long as the step — stalling every request behind it, before any
// request timeout applies.

// A namespace import, not a destructured one: node:test's mocked timers only
// replace what's looked up on the module at call time.
import * as timers from "node:timers/promises";
import { untilCancelled } from "./call.ts";

export class RateLimiter {
  readonly #minIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  // null = no acquisition has happened yet, so the min-interval gate doesn't
  // apply. An explicit sentinel rather than 0: performance.now() starts near 0
  // at process start, so a 0 sentinel would delay the very first request.
  #lastStart: number | null = null;

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = Math.max(0, minIntervalMs);
  }

  /** Resolves when the caller is allowed to proceed; rejects with
   *  CallCancelled as soon as `signal` fires — queued behind earlier waiters
   *  or waiting out its own spacing alike. A cancelled waiter never takes the
   *  slot, and its turn still passes on to the next one in order. */
  acquire(signal?: AbortSignal): Promise<void> {
    const prev = this.#tail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.#tail = promise;

    const turn = prev.then(async () => {
      try {
        if (signal?.aborted) return; // cancelled while queued: pass the turn on
        const wait = this.#delayUntilAllowed();
        if (wait > 0) await timers.setTimeout(wait, undefined, { signal });
        signal?.throwIfAborted();
        this.#lastStart = performance.now();
      } finally {
        // Release the next waiter's gate; the spacing above keeps them in line.
        release();
      }
    });
    return untilCancelled(turn, signal);
  }

  /** Delay (ms) before another acquisition may start, honoring the min interval. */
  #delayUntilAllowed(): number {
    if (this.#lastStart === null) return 0;
    return Math.max(0, this.#lastStart + this.#minIntervalMs - performance.now());
  }
}
